# Copyright (c) 2026 Memlia. All rights reserved.
"""Portable protocol tests only: no Excel, subprocess, filesystem or authority double."""
import importlib.util
import json
import unittest


class ExcelComTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('memlia_agent.excel_com'),
                             'The controlled CLI protocol adapter is missing')
        return __import__('memlia_agent.excel_com', fromlist=['prepare_batch'])

    def request(self):
        return dict(pipe_name='MemliaExcel-0123456789abcdef0123456789abcdef',
                    session_id='owned-session-01', operations=[
            {'command': 'range.set-values', 'args': {'sheetName': 'Feuil1',
             'rangeAddress': 'A1:B1', 'values': [[12, 8]]}},
            {'command': 'range.get-values', 'args': {'sheetName': 'Feuil1',
             'rangeAddress': 'A1:B1'}}])

    def test_batch_is_fully_validated_captured_and_not_executed(self):
        m=self.module();request=self.request();plan=m.prepare_batch(**request)
        request['operations'][0]['args']['values'][0][0]=999
        body=json.loads(plan.input_bytes)
        self.assertEqual(body[0]['args']['values'], [[12,8]])
        self.assertEqual(body[0]['args']['overwritePolicy'], 'reject-nonempty')
        self.assertEqual([x['sessionId'] for x in body], ['owned-session-01']*2)
        self.assertEqual(plan.arguments, ('-q','batch','--input','-','--stop-on-error'))
        self.assertEqual(plan.environment, (('EXCELMCP_TELEMETRY_MODE','off'),
                                            ('EXCELMCP_CLI_PIPE',plan.pipe_name)))
        self.assertNotIn('Feuil1', repr(plan))
        self.assertNotEqual(m.new_pipe_name(), m.new_pipe_name())

    def test_owned_session_reuses_its_pipe_instead_of_creating_another_daemon(self):
        m=self.module();pipe='MemliaExcel-0123456789abcdef0123456789abcdef'
        request=self.request();request['pipe_name']=pipe
        plan=m.prepare_batch(**request)
        self.assertEqual(plan.pipe_name,pipe)
        self.assertEqual(dict(plan.environment)['EXCELMCP_CLI_PIPE'],pipe)
        self.assertNotIn('--pipe-name',plan.arguments)

    def test_later_invalid_command_refuses_whole_batch(self):
        m=self.module();request=self.request();request['operations'].append({'command':'vba.run','args':{}})
        with self.assertRaises(m.ExcelComError) as caught: m.prepare_batch(**request)
        self.assertEqual(str(caught.exception),'invalid_batch')
        self.assertIsNone(caught.exception.__context__)

    def lines(self):
        return [
            {'index':0,'command':'range.set-values','success':True,
             'result':{'success':True,'action':'set-values','filePath':'PRIVATE-CANARY.xlsx'}},
            {'index':1,'command':'range.get-values','success':True,
             'result':{'success':True,'sheetName':'Feuil1','rangeAddress':'$A$1:$B$1',
                       'rowCount':1,'columnCount':2,'values':[[12,8]],'cellErrors':[]}}]

    def reader(self):
        m=self.module()
        return m,m.BatchReader(m.prepare_batch(**self.request()))

    def encode(self, items):
        return b'\n'.join(json.dumps(x).encode() for x in items)+b'\n'

    def test_incremental_native_ndjson_readback_is_private_and_not_save_or_closure(self):
        m,r=self.reader();data=self.encode(self.lines())
        for i in range(0,len(data),7): r.feed(data[i:i+7])
        observation=r.finish(exit_code=0)
        self.assertEqual(observation.status,'reported_complete')
        self.assertEqual(observation.reported_successes,2)
        self.assertEqual(observation.readbacks,((1,b'[[12,8]]'),))
        self.assertNotIn('PRIVATE-CANARY',repr(observation))
        self.assertNotIn('[[12,8]]',repr(observation))
        with self.assertRaises(m.ExcelComError): r.feed(b'')
        with self.assertRaises(m.ExcelComError): r.finish(exit_code=0)

    def test_partial_failure_retains_prefix_without_echoing_native_error(self):
        m,r=self.reader();items=self.lines();items[1]={'index':1,'command':'range.get-values',
            'success':False,'errorMessage':'PRIVATE-CANARY-PATH','partialState':{'secret':'CANARY'}}
        r.feed(self.encode(items));out=r.finish(exit_code=1)
        self.assertEqual((out.status,out.reported_successes,out.failed_index),('partial_or_unknown',1,1))
        self.assertNotIn('CANARY',repr(out))

    def test_stop_on_error_violation_and_exit_disagreement_remain_unknown(self):
        m,r=self.reader();items=self.lines();items[0]['success']=False
        with self.assertRaises(m.ExcelComError): r.feed(self.encode(items))
        self.assertEqual(r.finish(exit_code=1).status,'unknown')
        for code in (None,True,1,124):
            with self.subTest(code=code):
                m,r=self.reader();r.feed(self.encode(self.lines()))
                self.assertEqual(r.finish(exit_code=code).status,'unknown')

    def test_missing_record_bad_json_duplicate_index_and_wrong_command_refuse(self):
        m,r=self.reader();r.feed(self.encode(self.lines()[:1]));self.assertEqual(r.finish(exit_code=0).status,'unknown')
        invalid=[b'{"index":0,"index":0}\n',b'PRIVATE-CANARY\n',b'\xff\n',b'{}\n',b'[]\n',b'\n']
        for change in ({'index':True},{'index':1},{'command':'vba.run'},{'success':1},{'extra':'CANARY'}):
            item=self.lines()[0];item.update(change);invalid.append(self.encode([item]))
        for data in invalid:
            with self.subTest(data=data[:24]):
                m,r=self.reader()
                with self.assertRaises(m.ExcelComError) as caught: r.feed(data)
                self.assertIsNone(caught.exception.__context__)
                self.assertEqual(r.finish(exit_code=0).status,'unknown')

    def test_nested_negative_errors_mismatched_readback_or_cell_error_never_complete(self):
        changes=[{'success':False},{'sheetName':'Foreign'}, {'rangeAddress':'A2:B2'},
                 {'rowCount':True},{'columnCount':3},{'values':[[12]]},
                 {'values':[[float('inf'),8]]},{'cellErrors':[{'raw':'PRIVATE-CANARY'}]}]
        for change in changes:
            with self.subTest(change=change):
                m,r=self.reader();items=self.lines();items[1]['result'].update(change)
                with self.assertRaises(m.ExcelComError): r.feed(self.encode(items))
                self.assertEqual(r.finish(exit_code=0).status,'unknown')

    def test_output_limits_are_enforced_during_read_not_after_collection(self):
        for data in (b'x'*65537,b'x'*1048577):
            m,r=self.reader()
            with self.assertRaises(m.ExcelComError) as caught: r.feed(data)
            self.assertEqual(caught.exception.code,'output_limit')
            self.assertEqual(r.finish(exit_code=0).status,'unknown')

    def test_invalid_inputs_never_produce_batch(self):
        invalid=[]
        for address in ('A0','XFE1','A1048577','A2:A1','A1:XFD1048576','[foreign]A1','A:A','R1C1','A1,A2'):
            r=self.request();r['operations'][0]['args']['rangeAddress']=address;invalid.append(r)
        for values in ([[float('nan'),8]],[[float('inf'),8]],[[2**53,8]],[[{'x':1},8]],
                       [['=WEBSERVICE("https://invalid")',8]],[[' +1',8]],[[12]],[[12,8],[9,8]]):
            r=self.request();r['operations'][0]['args']['values']=values;invalid.append(r)
        for extra in ({'valuesFile':'foreign.json'},{'overwritePolicy':'allow'},{'sessionId':'foreign'}):
            r=self.request();r['operations'][0]['args'].update(extra);invalid.append(r)
        for value in ('','bad id','x'*129,'../foreign'):
            r=self.request();r['session_id']=value;invalid.append(r)
        for operations in ([],self.request()['operations']*9):
            r=self.request();r['operations']=operations;invalid.append(r)
        for pipe in ('default', '../foreign', 'MemliaExcel-'+'A'*32, None):
            r=self.request();r['pipe_name']=pipe;invalid.append(r)
        m=self.module()
        for request in invalid:
            with self.subTest(request=request):
                with self.assertRaises(m.ExcelComError) as caught: m.prepare_batch(**request)
                self.assertEqual(str(caught.exception),'invalid_batch')
                self.assertIsNone(caught.exception.__context__)

    def test_reader_rejects_forged_plan_and_retains_cancellation(self):
        from dataclasses import replace
        from unittest.mock import patch
        m=self.module();plan=m.prepare_batch(**self.request())
        for payload in (b'[]',b'null',b'{}',b'[null]',b'[[0]]'):
            with self.subTest(payload=payload):
                with self.assertRaises(m.ExcelComError): m.BatchReader(replace(plan,input_bytes=payload))
        with patch.object(m.json,'loads',side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt): m.BatchReader(plan)

    def test_write_requires_matching_readback_and_exact_observed_values(self):
        m=self.module();request=self.request();request['operations'].pop()
        with self.assertRaises(m.ExcelComError): m.prepare_batch(**request)
        for values in ([[12,9]],[[True,8]],[['12',8]]):
            with self.subTest(values=values):
                m,r=self.reader();items=self.lines();items[1]['result']['values']=values
                with self.assertRaises(m.ExcelComError): r.feed(self.encode(items))
                result=r.finish(exit_code=0)
                self.assertEqual(result.status,'unknown')
                self.assertEqual(result.reported_successes,1)
        m,r=self.reader();items=self.lines();items[1]['result']['values']=[[12.0,8.0]]
        r.feed(self.encode(items));self.assertEqual(r.finish(exit_code=0).status,'reported_complete')

    def test_input_byte_limit_and_unicode_refuse_without_decoder_context(self):
        m=self.module()
        request=self.request()
        request['operations'][0]['args'].update(rangeAddress='A1:AZ1',values=[['x'*4096]*52])
        request['operations'][1]['args']['rangeAddress']='A1:AZ1'
        # Two pairs exceed 256 KiB; each individual range remains within bounds.
        request['operations']*=2
        with self.assertRaises(m.ExcelComError) as caught: m.prepare_batch(**request)
        self.assertEqual(caught.exception.code,'invalid_batch')
        self.assertIsNone(caught.exception.__context__)
        request=self.request();request['operations'][0]['args']['values']=[['\ud800',8]]
        with self.assertRaises(m.ExcelComError): m.prepare_batch(**request)

    def test_read_only_batch_needs_no_write_and_empty_transport_remains_unknown(self):
        m=self.module();request=self.request();request['operations']=request['operations'][1:]
        plan=m.prepare_batch(**request);reader=m.BatchReader(plan)
        item=self.lines()[1];item['index']=0
        reader.feed(self.encode([item]))
        self.assertEqual(reader.finish(exit_code=0).status,'reported_complete')
        reader=m.BatchReader(plan)
        self.assertEqual(reader.finish(exit_code=0).status,'unknown')

    def test_batch_and_plan_repr_keep_private_session_out(self):
        m=self.module();plan=m.prepare_batch(**self.request())
        self.assertNotIn('owned-session-01',repr(plan))
        self.assertNotIn('Feuil1',repr(plan))

if __name__=='__main__': unittest.main()
