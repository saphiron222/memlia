# Copyright (c) 2026 Memlia. All rights reserved.
"""Portable preparation tests; no Docker, PostgreSQL or authenticated API claim."""
import base64
import ast
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

import application_qualification as a
import qualification as q


class ApplicationOracleTests(unittest.TestCase):
    def answer(self):
        from memlia_excel.process import prepare
        answer = prepare(json.loads(q.fixture_wire()))
        content = base64.b64decode(answer['outputs'][0]['contentBase64'])
        return dict(status='passed', scope='native_api_in_process',
                    checks={name: True for name in a.CHECKS},
                    file=dict(contentBase64=base64.b64encode(content).decode(),
                              sha256='sha256:'+sha256(content).hexdigest(),
                              size=len(content), contentType=a.XLSX),
                    download=dict(status=200, contentType=a.XLSX,
                                  contentLength=len(content),
                                  contentBase64=base64.b64encode(content).decode()))

    def test_real_xlsx_download_matches_the_same_native_recorded_file(self):
        result = a.verify_result(json.dumps(self.answer()).encode())
        self.assertEqual(result['scope'], 'native_api_in_process')
        self.assertTrue(result['sameRecordedOutput'])
        self.assertNotIn('contentBase64', json.dumps(result))

    def test_changed_download_equal_size_is_refused(self):
        value=self.answer()
        content=bytearray(base64.b64decode(value['download']['contentBase64']))
        content[-1] ^= 1
        value['download']['contentBase64']=base64.b64encode(content).decode()
        with self.assertRaises(ValueError):a.verify_result(json.dumps(value).encode())

    def test_missing_authority_case_or_extra_field_never_qualifies(self):
        original=self.answer()
        for name in a.CHECKS:
            value=deepcopy(original);value['checks'][name]=False
            with self.subTest(name=name),self.assertRaises(ValueError):
                a.verify_result(json.dumps(value).encode())
        for delta in ({'httpQualified':True},{'secret':'PRIVATE_CANARY'}):
            with self.assertRaises(ValueError):a.verify_result(json.dumps(original|delta).encode())

    def test_digest_mime_size_and_boolean_status_are_not_coerced(self):
        original=self.answer()
        for part,key,value in [('file','sha256','sha256:'+'0'*64),
                               ('file','size',True),('download','status',True),
                               ('download','contentType','application/octet-stream'),
                               ('download','contentLength',0)]:
            changed=deepcopy(original);changed[part][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):
                a.verify_result(json.dumps(changed).encode())

    def test_duplicate_json_and_oversize_are_refused(self):
        raw=json.dumps(self.answer()).encode()
        for value in (raw.replace(b'"status": "passed"',b'"status":"failed","status":"passed"'),
                      b' '*(a.MAX_RESULT+1)):
            with self.assertRaises(ValueError):a.verify_result(value)


class ApplicationBoundaryTests(unittest.TestCase):
    def test_operator_precondition_precedes_resources(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(a.os,'getuid',return_value=1001):
            work=Path(temporary)/'not-created'
            with self.assertRaises(ValueError):
                a.consume(Path('/run/not-opened/host.sock'),b'{}',time.monotonic()+1,
                          threading.Event(),work,{})
            self.assertFalse(work.exists())

    def test_inspection_requires_exact_identity_limits_and_live_nonoom(self):
        row=dict(Id='a'*64,Config={'Labels':{'org.memlia.excel.application':'b'*32},'User':'1001:1001'},
                 State={'Running':True,'OOMKilled':False},
                 HostConfig={'ReadonlyRootfs':True,'Privileged':False,'Memory':4*1024**3,
                             'MemorySwap':4*1024**3,'NanoCpus':2_000_000_000,'PidsLimit':256,
                             'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true']})
        a.inspect_owned(row,'a'*64,'b'*32,'1001:1001',4*1024**3,2_000_000_000,256,running=True)
        for area,key,value in [('State','OOMKilled',True),('State','Running',False),
                               ('HostConfig','MemorySwap',-1),('HostConfig','ReadonlyRootfs',False),
                               ('Config','User','0:0')]:
            changed=deepcopy(row);changed[area][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):
                a.inspect_owned(changed,'a'*64,'b'*32,'1001:1001',4*1024**3,2_000_000_000,256,running=True)

    def test_missing_extra_or_writable_source_mount_never_passes(self):
        expected={'/work':('/owned/source',False),'/scratch':('/owned/scratch',True)}
        row={'HostConfig':{'Tmpfs':{'/tmp':'rw,noexec'}},'Mounts':[
            {'Type':'bind','Destination':'/work','Source':'/owned/source','RW':False,'Propagation':'rprivate'},
            {'Type':'bind','Destination':'/scratch','Source':'/owned/scratch','RW':True,'Propagation':'rprivate'}]}
        a.inspect_mounts(row,expected)
        for edit in ('missing','extra','writable','duplicate','volume','propagation'):
            changed=deepcopy(row)
            if edit=='missing':changed.pop('Mounts')
            elif edit=='extra':changed['Mounts'].append({'Type':'bind','Destination':'/var/run/docker.sock','Source':'/var/run/docker.sock','RW':True,'Propagation':'rprivate'})
            elif edit=='writable':changed['Mounts'][0]['RW']=True
            elif edit=='duplicate':changed['Mounts'].append(changed['Mounts'][0])
            elif edit=='volume':changed['Mounts'][0]['Type']='volume'
            else:changed['Mounts'][0]['Propagation']='rshared'
            with self.subTest(edit=edit),self.assertRaises(ValueError):a.inspect_mounts(changed,expected)

    def test_owned_tree_refuses_symlink_and_hardlink_without_removing_target(self):
        import os
        for link in ('symlink','hardlink'):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)/'owned';root.mkdir();external=Path(temporary)/'foreign';external.write_bytes(b'untouched')
                if link=='symlink':(root/'link').symlink_to(external)
                else:os.link(external,root/'link')
                with self.assertRaises(ValueError):a.tree_snapshot(root)
                self.assertEqual(external.read_bytes(),b'untouched')

    def test_closed_owned_tree_removes_nested_native_files_only_after_identity_readback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'owned';(root/'nested/deep').mkdir(parents=True)
            (root/'nested/deep/output.xlsx').write_bytes(b'owned-test')
            (root/'result.json').write_bytes(b'{}')
            snapshot=a.tree_snapshot(root)
            a.remove_closed_tree(root,snapshot)
            self.assertFalse(root.exists())

    def test_file_changed_after_snapshot_is_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'owned';root.mkdir();path=root/'output'
            path.write_bytes(b'before');snapshot=a.tree_snapshot(root);path.write_bytes(b'changed')
            with self.assertRaises(ValueError):a.remove_closed_tree(root,snapshot)
            self.assertEqual(path.read_bytes(),b'changed')


class DurableSubmissionTests(unittest.TestCase):
    def submission(self):
        return dict(status='passed',scope='native_session_durable_submission',
                    authenticated=True,deployed=True,queued=True,browserClosed=True,
                    workflowId='owned-workflow',workspaceId='owned-workspace',
                    deploymentVersionId='owned-deployment',executionId='owned-execution',
                    jobId='workflow-execution:owned-execution')

    def test_native_session_202_and_closed_browser_are_required_before_worker(self):
        prepared=dict(workflowId='owned-workflow',workspaceId='owned-workspace')
        value=self.submission()
        self.assertEqual(a.verify_durable_submission(json.dumps(value).encode(),prepared),value)
        for delta in ({'authenticated':False},{'deployed':False},{'queued':False},
                      {'browserClosed':False},{'workflowId':'foreign'},
                      {'scope':'native_api_in_process'},{'jobId':'inline-job'},
                      {'apiKey':'PRIVATE_CANARY'},{'queued':1}):
            with self.subTest(delta=delta),self.assertRaises(ValueError):
                a.verify_durable_submission(json.dumps(value|delta).encode(),prepared)

    def test_durable_mode_requires_root_host_and_rejects_operator_promotion_before_output(self):
        for flags in ({},{'exercise_host':True,'operator_release':Path('/run/unused')}):
            with tempfile.TemporaryDirectory() as temporary, mock.patch.object(q,'require_linux'), \
                 mock.patch.object(q.os,'getuid',return_value=0):
                output=Path(temporary)/'never-created'
                with self.assertRaisesRegex(ValueError,'durable_mode_required'):
                    q.run(Path('/not-read'),output,durable_config=Path('/not-read'),**flags)
                self.assertFalse(output.exists())

    def test_product_bootstrap_receipt_requires_closed_negative_privilege_assertions(self):
        nonce='a'*32
        value=dict(version='memlia.database-bootstrap-receipt/v1',status='PASS',phase='verify',prepared=True,grantsVerified=True,
                   transportBusinessRead=False,runtimeDdl=False,database='memlia_ui_'+nonce,
                   queueSchema='memlia_jobs',deploymentId=nonce,runtimeDdlScope='business_roles;transport_owns_queue_schema')
        a.verify_bootstrap_receipt(json.dumps(value).encode(),'verify',nonce)
        for delta in ({'transportBusinessRead':True},{'runtimeDdl':True},{'grantsVerified':1},
                      {'deploymentId':'b'*32},{'database':'existing'}, {'password':'PRIVATE_CANARY'}):
            with self.subTest(delta=delta),self.assertRaises(ValueError):
                a.verify_bootstrap_receipt(json.dumps(value|delta).encode(),'verify',nonce)

    def test_durable_result_has_its_own_scope_and_requires_one_native_attempt_ack_and_log(self):
        value=ApplicationOracleTests().answer()
        value['scope']='native_durable_compose'
        value['checks']['ownedRunFixtureRetired']=False
        value['durable']=dict(jobId='workflow-execution:owned-run',executionId='owned-run',
                              completed=True,attempts=1,transportAcked=True,oneDelivery=True,oneExecutionLog=True)
        answer=a.verify_durable_result(json.dumps(value).encode(),value['durable'])
        self.assertTrue(answer['businessPassed'])
        self.assertNotIn('contentBase64',json.dumps(answer))
        for delta in ({'attempts':True},{'attempts':2},{'transportAcked':False},
                      {'oneDelivery':False},{'oneExecutionLog':False}):
            changed=deepcopy(value);changed['durable'].update(delta)
            with self.subTest(delta=delta),self.assertRaises(ValueError):
                a.verify_durable_result(json.dumps(changed).encode(),value['durable'])


class DurableConfigurationTests(unittest.TestCase):
    def config(self):
        images={name:dict(reference='fixture.invalid/memlia/'+name+'@sha256:'+'a'*64,
                          imageId='sha256:'+'b'*64,sourceCommit='c'*40,lockSha256='d'*64)
                for name in ('web','realtime','migrations','cron','workflow-worker')}
        images.update(db=dict(reference=a.POSTGRES,imageId='sha256:'+'e'*64),
                      redis=dict(reference=a.CACHE,imageId='sha256:'+'f'*64))
        return dict(schemaVersion='memlia.excel-durable-qualification/v1',sourceCommit='c'*40,
                    lockSha256='d'*64,nonce='a'*32,envFile='/run/owned/compose.env',
                    bootstrapFile='/run/owned/bootstrap.json',images=images,
                    browser={name:dict(path='/usr/bin/'+name,sha256='e'*64)
                             for name in ('node','chromium','certutil','ca')})

    def test_images_are_exact_and_share_the_one_source_and_lock(self):
        value=self.config();self.assertEqual(a.durable_configuration(value),value)
        for delta in ('lock','source','image','role-service','extra','relative'):
            changed=deepcopy(value)
            if delta=='lock':changed['images']['web']['lockSha256']='e'*64
            elif delta=='source':changed['images']['workflow-worker']['sourceCommit']='e'*40
            elif delta=='image':changed['images']['web']['reference']='fixture.invalid/memlia/web:latest'
            elif delta=='role-service':changed['images'].pop('workflow-worker')
            elif delta=='extra':changed['arbitraryCommand']='PRIVATE_CANARY'
            else:changed['envFile']='relative.env'
            with self.subTest(delta=delta),self.assertRaises(ValueError):a.durable_configuration(changed)

    def test_actual_image_identity_and_labels_must_attest_the_candidate_not_only_config(self):
        config=self.config();image=config['images']['web']
        row=dict(Id=image['imageId'],Os='linux',Architecture='amd64',RepoDigests=[image['reference']],
                 Config=dict(Labels={'org.memlia.source':config['sourceCommit'],'org.memlia.lock':config['lockSha256']}))
        a.verify_durable_image(row,'web',config)
        for edit in ('source','lock','absent','id','architecture','tag'):
            changed=deepcopy(row)
            if edit in ('source','lock'):changed['Config']['Labels']['org.memlia.'+edit]='e'*64
            elif edit=='absent':changed['Config']['Labels']={}
            elif edit=='id':changed['Id']='sha256:'+'e'*64
            elif edit=='architecture':changed['Architecture']='arm64'
            else:changed['RepoDigests']=[]
            with self.subTest(edit=edit),self.assertRaises(ValueError):a.verify_durable_image(changed,'web',config)

    def model(self):
        config=self.config();project='memlia-excel-durable-'+config['nonce']
        services={name:dict(image=value['reference'],environment={}) for name,value in config['images'].items()}
        for name,role in (('web','web'),('realtime','realtime'),('migrations','migrate'),('workflow-worker','worker')):
            services[name]['environment']['DATABASE_URL']='postgres://ui_'+role+'_'+config['nonce']+':fictitious@database:5432/memlia_ui_'+config['nonce']
        for name in ('web','realtime','workflow-worker'):
            services[name]['environment'].update(BETTER_AUTH_URL='https://localhost:8443',NEXT_PUBLIC_APP_URL='https://localhost:8443')
        queue='postgres://ui_transport_'+config['nonce']+':fictitious@database:5432/memlia_ui_'+config['nonce']
        for name in ('web','workflow-worker'):
            services[name]['environment'].update(MEMLIA_DURABLE_WORKFLOWS_ENABLED='1',MEMLIA_PG_BOSS_ENABLED='1',
                MEMLIA_PG_BOSS_DATABASE_URL=queue,TRIGGER_DEV_ENABLED='false')
        uploads=dict(type='volume',source='uploads',target='/app/apps/sim/uploads')
        services['web']['volumes']=[uploads]
        services['workflow-worker'].update(user='1001:1001',read_only=True,working_dir='/app/apps/sim',pull_policy='never',
            restart='no',cap_drop=['ALL'],security_opt=['no-new-privileges:true'],mem_limit=4*1024**3,
            memswap_limit=4*1024**3,cpus=2,pids_limit=256,
            volumes=[deepcopy(uploads),dict(type='bind',source='/run/owned-host',target='/run/memlia-excel',
                                          read_only=True,bind=dict(create_host_path=False))])
        services['workflow-worker']['environment'].update(MEMLIA_EXCEL_HOST_SOCKET='/run/memlia-excel/host.sock',
                                                        MEMLIA_EXCEL_HOST_OPERATOR_UID='0')
        return dict(name=project,services=services,volumes={name:dict(name=project+'_'+name)
                    for name in ('uploads','db_data','redis_data')},
                    networks={name:dict(name=project+'_'+name) for name in ('backend','egress')})

    def test_product_preflight_and_worker_socket_upload_roles_remain_mandatory(self):
        config=self.config();model=self.model();socket=Path('/run/owned-host/host.sock')
        self.assertEqual(a.validate_durable_model(model,config,socket),'https://localhost:8443')
        for edit in ('root','inline','shared-role','http','foreign-image','socket','uploads','external','docker','trusted-client'):
            changed=deepcopy(model);worker=changed['services']['workflow-worker']
            if edit=='root':worker['user']='0:0'
            elif edit=='inline':worker['command']=['bun','inline.ts']
            elif edit=='shared-role':worker['environment']['DATABASE_URL']=changed['services']['web']['environment']['DATABASE_URL']
            elif edit=='http':changed['services']['web']['environment']['BETTER_AUTH_URL']='http://localhost:8443'
            elif edit=='foreign-image':worker['image']=worker['image'].replace('a'*64,'f'*64)
            elif edit=='socket':worker['volumes'][1]['read_only']=False
            elif edit=='uploads':worker['volumes'][0]['source']='other'
            elif edit=='external':changed['volumes']['uploads']['external']=True
            elif edit=='trusted-client':changed['services']['web']['environment']['AUTH_TRUSTED_PROXIES']='127.0.0.1'
            else:worker['volumes'].append(dict(type='bind',source='/var/run/docker.sock',target='/var/run/docker.sock'))
            with self.subTest(edit=edit),self.assertRaises(ValueError):a.validate_durable_model(changed,config,socket)


class DurableOrderingTests(unittest.TestCase):
    def test_durable_campaign_never_replays_the_legacy_in_process_business_recipe(self):
        tree=ast.parse(Path(q.__file__).read_text())
        branch=next(node for node in ast.walk(tree) if isinstance(node,ast.If)
                    and ast.unparse(node.test)=='application_work is not None')
        code=compile(ast.fix_missing_locations(ast.Module(body=[branch],type_ignores=[])),q.__file__,'exec')
        for configuration in (None,Path('/run/private/config.json')):
            with mock.patch.object(a,'consume') as legacy,mock.patch.object(a,'consume_durable') as durable:
                record={};scope=dict(application_work=Path('/owned/application'),durable_config=configuration,
                    record=record,socket_path=Path('/owned/host.sock'),wire=b'owned',deadline=1,cancel=threading.Event())
                exec(code,scope)
                self.assertEqual(legacy.call_count,int(configuration is None))
                self.assertEqual(durable.call_count,int(configuration is not None))
                self.assertEqual(set(record),{'stage','application' if configuration is None else 'durableApplication'})

    def up(self,record):
        # Execute the consumed closure verbatim; Compose itself is the IO double.
        consume=next(n for n in ast.parse(Path(a.__file__).read_text()).body
                     if isinstance(n,ast.FunctionDef) and n.name=='consume_durable')
        node=deepcopy(next(n for n in consume.body if isinstance(n,ast.FunctionDef) and n.name=='up'))
        node.body=[ast.Global(names=n.names) if isinstance(n,ast.Nonlocal) else n for n in node.body]
        calls=[]
        scope=dict(record=record,started=False,require=a.require,compose=['docker','compose'],
                   client=lambda argv:calls.append(argv),discover=lambda:None)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),a.__file__,'exec'),scope)
        return scope['up'],calls

    def test_worker_never_starts_before_browser_group_closure_and_native_publication(self):
        good=dict(browserClosedBeforeWorker=True,bootstrapPhases=['prepare','grants','verify'],
                  fixturePhases=['metadata','baseline','seed','durable-prepare','durable-publish'],
                  clientSessions=[dict(waited=True,groupClosed=True)])
        for delta in ({'browserClosedBeforeWorker':False},{'fixturePhases':['durable-prepare']},
                      {'bootstrapPhases':['prepare']},{'clientSessions':[dict(waited=True,groupClosed=False)]}):
            up,calls=self.up(good|delta)
            with self.subTest(delta=delta),self.assertRaises(ValueError):up('workflow-worker')
            self.assertEqual(calls,[])
        up,calls=self.up(good);up('workflow-worker');self.assertEqual(len(calls),1)


class DurableResourceTests(unittest.TestCase):
    def closure(self,name,scope):
        consume=next(node for node in ast.parse(Path(a.__file__).read_text()).body
                     if isinstance(node,ast.FunctionDef) and node.name=='consume_durable')
        node=next(node for node in consume.body if isinstance(node,ast.FunctionDef) and node.name==name)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[deepcopy(node)],type_ignores=[])),a.__file__,'exec'),scope)
        return scope[name]

    def test_bootstrap_parent_is_private_directory_not_an_implicit_docker_file_parent(self):
        calls=[];nonce='a'*32;record={'clientSessions':[]}
        value=dict(version='memlia.database-bootstrap-receipt/v1',status='PASS',phase='prepare',prepared=True,
                   grantsVerified=False,transportBusinessRead=False,runtimeDdl=False,database='memlia_ui_'+nonce,
                   queueSchema='memlia_jobs',deploymentId=nonce,runtimeDdlScope='business_roles;transport_owns_queue_schema')
        def oneoff(*args):
            calls.append(args);record['clientSessions'].append(dict(waited=True,groupClosed=True))
            return json.dumps(value).encode()
        scope=dict(record=record,private_bootstrap=Path('/owned/work/bootstrap'),bootstrap_volume='owned_state',
                   oneoff=oneoff,image=lambda name:'exact:'+name,verify_bootstrap_receipt=a.verify_bootstrap_receipt,
                   nonce=nonce,require=a.require)
        self.closure('bootstrap_phase',scope)('prepare')
        self.assertEqual(calls[0][4][0],'type=bind,src=/owned/work/bootstrap,dst=/run/memlia,readonly')
        self.assertEqual(calls[0][5],['bun','--no-env-file','/app/deploy/memlia/database-bootstrap.ts',
                                     '--config','/run/memlia/bootstrap.json','--phase','prepare'])
        self.assertEqual(record['bootstrapPhases'],['prepare'])

    def test_fixture_uses_image_dependencies_and_the_schema_owner_only_for_metadata(self):
        calls=[];scope=dict(record={},ROOT=Path('/owned/source'),scratch=Path('/owned/work/scratch'),
            work=Path('/owned/work'),model={'volumes':{'uploads':{'name':'owned_uploads'}}},
            image=lambda name:'exact:'+name,oneoff=lambda *args:calls.append(args))
        phase=self.closure('fixture_phase',scope)
        for mode in ('metadata','seed','durable-readback','metadata-final'):phase(mode)
        self.assertEqual([call[3] for call in calls],[Path('/owned/work/metadata.env'),
            Path('/owned/work/fixture.env'),Path('/owned/work/fixture.env'),Path('/owned/work/metadata.env')])
        for call in calls:
            self.assertEqual(call[2],'1001:1001');self.assertEqual(call[6],'/app/apps/sim')
            self.assertEqual(len(call[4]),4)
            self.assertTrue(all('/node_modules' not in mount and 'dst=/work' not in mount for mount in call[4]))
            self.assertTrue(call[5][3].startswith('/app/'))

    def finalize(self,*,complete,group_closed=True,foreign_volume=False):
        consume=next(node for node in ast.parse(Path(a.__file__).read_text()).body
                     if isinstance(node,ast.FunctionDef) and node.name=='consume_durable')
        final=next(node for node in reversed(consume.body) if isinstance(node,ast.Try)).finalbody
        calls=[];running=True;container=True;project='owned';nonce='a'*32;cid='b'*64
        record=dict(cleanupComplete=False,resourcesRetained=True,clientSessions=[dict(waited=True,groupClosed=group_closed)])
        labels={'com.docker.compose.project':project,'org.memlia.excel.application':nonce}
        def raw(args,**kwargs):
            if args[:2]==['container','inspect']:return json.dumps([dict(State=dict(Running=running))]).encode()
            if args[:2]==['container','ls']:return cid.encode() if container else b''
            if args[1]=='inspect':
                row=dict(Name=args[2],Labels=labels|({'org.memlia.excel.application':'foreign'} if foreign_volume and args[0]=='volume' else {}))
                row.update(dict(Containers={}) if args[0]=='network' else dict(Driver='local',Options={}))
                return json.dumps([row]).encode()
            return b''
        def cmd(args,**kwargs):
            nonlocal running,container
            calls.append(args)
            if args[:2]==['container','stop']:running=False
            elif args[:2]==['container','rm']:container=False
        work=mock.Mock();work.stat.return_value=type('Stat',(),dict(st_dev=1,st_ino=2))()
        scope=dict(record=record,require=a.require,started=True,complete=complete,closed=True,
            discover=lambda:[cid],raw=raw,s=a.s,owned={cid:('workflow-worker',)},cmd=cmd,json=json,
            model={'networks':{'backend':{'name':'owned_backend'}},'volumes':{'uploads':{'name':'owned_uploads'}}},
            bootstrap_volume='owned_state',project=project,nonce=nonce,profile=mock.Mock(exists=lambda:False),
            work=work,identity=(1,2),tree_snapshot=lambda path:{},remove_closed_tree=lambda *args:calls.append(['tree','remove']),
            remember_failure=lambda *args:record.update(finalizationFailure=True))
        exec(compile(ast.fix_missing_locations(ast.Module(body=deepcopy(final),type_ignores=[])),a.__file__,'exec'),scope)
        return calls,record

    def test_complete_cleanup_stops_container_before_removing_owned_volumes(self):
        calls,record=self.finalize(complete=True)
        self.assertEqual(calls[:2],[['container','stop','--time','160','b'*64],['container','rm','b'*64]])
        self.assertEqual(calls[-1],['tree','remove']);self.assertTrue(record['cleanupComplete'])
        self.assertFalse(record['resourcesRetained'])

    def test_unknown_business_or_client_closure_never_erases_database_or_queue_state(self):
        for complete,closed in ((False,True),(True,False)):
            calls,record=self.finalize(complete=complete,group_closed=closed)
            self.assertFalse(record['cleanupComplete']);self.assertTrue(record['resourcesRetained'])
            self.assertFalse(any(call[1]=='rm' for call in calls))

    def test_foreign_volume_marker_retains_that_volume_and_work_tree_for_reconciliation(self):
        calls,record=self.finalize(complete=True,foreign_volume=True)
        self.assertFalse(any(call[0] in ('volume','tree') for call in calls))
        self.assertFalse(record['cleanupComplete']);self.assertTrue(record['resourcesRetained'])


class CleanupDiagnosticTests(unittest.TestCase):
    def test_closed_cleanup_failure_projection_refuses_extra_or_unbounded_fields(self):
        value=dict(status='failed',code='fixture_cleanup_refused',stage='baseline_compare',
                   index=182,sqlstate='23503')
        self.assertEqual(a.project_cleanup_failure(json.dumps(value).encode()),value)
        for delta in ({'message':'PRIVATE_CANARY'},{'stage':'PRIVATE_CANARY'},
                      {'sqlstate':'23503\n'},{'sqlstate':'private'},{'sqlstate':True},
                      {'index':True},{'index':183},{'index':-1},
                      {'stage':'native_account_deletion','index':0}):
            with self.subTest(delta=delta),self.assertRaises(ValueError):
                a.project_cleanup_failure(json.dumps(value|delta).encode())
        raw=json.dumps(value).encode()
        for raw in (raw.replace(b'"status": "failed"',b'"status":"passed","status":"failed"'),
                    b' '*1025):
            with self.assertRaises(ValueError):a.project_cleanup_failure(raw)

    def run_phase(self, *, failure=None, exit_code=0, inspection_failure=False, raw=None):
        # Execute the real nested phase, with the Docker command/inspection boundary doubled.
        tree=ast.parse(Path(a.__file__).read_text())
        node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='phase')
        code=compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),a.__file__,'exec')
        record={'containers':[{'id':'a'*64,'closed':False}]};owned=[('a'*64,)]
        def inspect(*args,**kwargs):
            if inspection_failure:raise ValueError('PRIVATE_CANARY inspection')
            return {'State':{'ExitCode':exit_code}}
        calls=[]
        scope=dict(record=record,create=lambda *args:owned[0],NODE='fixture-image',
                   work=Path('/owned/work'),ROOT=Path('/owned/source'),tools=Path('/owned/tools'),
                   scratch=Path('/owned/scratch'),socket=Path('/owned/socket/host.sock'),
                   inspect=inspect,command=lambda args,**kwargs:calls.append(args) or b'',
                   owned=owned,require=a.require,read_closed=lambda *args:raw,
                   project_cleanup_failure=getattr(a,'project_cleanup_failure',None),
                   json=json,STAGES=a.STAGES,deadline=time.monotonic()+5,cancel=threading.Event())
        exec(code,scope)
        with mock.patch.object(q,'build_command',side_effect=failure):
            try:scope['phase']('cleanup')
            except Exception:pass
        return record,calls

    def test_execution_failure_is_classified_without_turning_it_into_success(self):
        raw=json.dumps(dict(status='failed',code='fixture_cleanup_refused',
                            stage='baseline_compare',index=3,sqlstate=None)).encode()
        record,calls=self.run_phase(failure=RuntimeError('PRIVATE_CANARY'),exit_code=1,raw=raw)
        self.assertEqual(record['cleanupExecution'],dict(boundary='execution',exitCode=1))
        self.assertEqual(record['cleanupFailure']['stage'],'baseline_compare')
        self.assertNotIn('phases',record)
        self.assertEqual(calls,[])
        self.assertNotIn('PRIVATE_CANARY',json.dumps(record))

    def test_invalid_private_receipt_and_unknown_exit_never_leak_or_pass(self):
        raw=b'{"status":"failed","message":"PRIVATE_CANARY"}'
        for exit_code in (-1,256,True,'PRIVATE_CANARY'):
            record,calls=self.run_phase(failure=RuntimeError('PRIVATE_CANARY'),exit_code=exit_code,raw=raw)
            self.assertEqual(record['cleanupExecution'],dict(boundary='execution',exitCode=None))
            self.assertNotIn('cleanupFailure',record)
            self.assertNotIn('phases',record);self.assertEqual(calls,[])
            self.assertNotIn('PRIVATE_CANARY',json.dumps(record))

    def test_owned_inspection_refusal_and_nonzero_exit_remain_refusals(self):
        record,calls=self.run_phase(inspection_failure=True)
        self.assertEqual(record['cleanupExecution'],dict(boundary='owned_inspection',exitCode=None))
        self.assertNotIn('phases',record);self.assertEqual(calls,[])
        record,calls=self.run_phase(exit_code=3)
        self.assertEqual(record['cleanupExecution'],dict(boundary='exit_code',exitCode=3))
        self.assertNotIn('phases',record);self.assertEqual(calls,[])

    def test_successful_ephemeral_cleanup_still_requires_closed_inspection_and_owned_removal(self):
        record,calls=self.run_phase()
        self.assertEqual(record['phases'],['cleanup'])
        self.assertTrue(record['containers'][0]['closed'])
        self.assertNotIn('cleanupExecution',record)
        self.assertEqual([args[:2] for args in calls],[['container','rm'],['container','ls']])


class FinalizationDiagnosticTests(unittest.TestCase):
    def test_private_first_error_precedes_closed_projection_and_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            work=Path(temporary)/'work';work.mkdir()
            record={'phase':'tree_remove'}
            a.remember_failure(work,record,PermissionError(13,'PRIVATE_CANARY'))
            receipt=Path(temporary)/'application-finalization-failure.private.json'
            first=receipt.read_bytes()
            self.assertIn(b'PRIVATE_CANARY',first)
            self.assertEqual(receipt.stat().st_mode & 0o777,0o600)
            self.assertEqual(record['firstFailure'],dict(code='application_recipe_refused',
                phase='tree_remove',kind='os_error',errno=13))
            self.assertTrue(record['failureEvidenceSaved'])
            record['phase']='network_cleanup'
            a.remember_failure(work,record,ValueError('SECOND_PRIVATE_CANARY'))
            self.assertEqual(receipt.read_bytes(),first)
            self.assertNotIn('PRIVATE_CANARY',json.dumps(record))

    def test_existing_failure_evidence_is_not_overwritten_or_followed(self):
        with tempfile.TemporaryDirectory() as temporary:
            work=Path(temporary)/'work';work.mkdir()
            external=Path(temporary)/'foreign';external.write_bytes(b'owned-by-other')
            (Path(temporary)/'application-finalization-failure.private.json').symlink_to(external)
            record={'phase':'SECRET_PHASE'}
            a.remember_failure(work,record,RuntimeError('PRIVATE_CANARY'*1000))
            self.assertFalse(record['failureEvidenceSaved'])
            self.assertEqual(record['firstFailure']['phase'],'unknown')
            self.assertNotIn('PRIVATE_CANARY',json.dumps(record))
            self.assertEqual(external.read_bytes(),b'owned-by-other')

    def final_cleanup(self,work,record):
        # Run the actual consume finally, not a reimplementation of its gates.
        consume=next(n for n in ast.parse(Path(a.__file__).read_text()).body
                     if isinstance(n,ast.FunctionDef) and n.name=='consume')
        final=next(n for n in reversed(consume.body) if isinstance(n,ast.Try))
        scope=dict(record=record,owned=[],command=lambda *args,**kwargs:b'',
            network=None,nonce='a'*32,all_closed=True,complete=True,work=work,
            identity=(work.stat().st_dev,work.stat().st_ino),require=a.require,
            remember_failure=a.remember_failure,tree_snapshot=a.tree_snapshot,
            remove_closed_tree=a.remove_closed_tree,s=a.s)
        code=compile(ast.fix_missing_locations(ast.Module(body=final.finalbody,type_ignores=[])),
                     a.__file__,'exec')
        exec(code,scope)
        return scope

    def test_real_final_cleanup_refuses_symlink_without_hiding_completed_readback(self):
        with tempfile.TemporaryDirectory() as temporary:
            work=Path(temporary)/'work';work.mkdir()
            target=Path(temporary)/'foreign';target.write_bytes(b'untouched')
            (work/'link').symlink_to(target)
            record={'phase':'readback','businessPassed':True,'readbackPassed':True,
                    'cleanupComplete':False,'resourcesRetained':True}
            result=self.final_cleanup(work,record)
            self.assertFalse(result['all_closed'])
            self.assertEqual(record['firstFailure']['phase'],'tree_snapshot')
            private=json.loads((Path(temporary)/'application-finalization-failure.private.json').read_bytes())
            self.assertEqual(private['detail'],'tree_symlink')
            self.assertTrue(record['businessPassed'] and record['readbackPassed'])
            self.assertFalse(record['cleanupComplete'])
            self.assertTrue(work.exists())
            self.assertEqual(target.read_bytes(),b'untouched')

    def test_real_final_cleanup_success_still_removes_only_the_owned_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            work=Path(temporary)/'work';work.mkdir();(work/'result').write_bytes(b'{}')
            record={'phase':'readback','businessPassed':True,'readbackPassed':True,
                    'cleanupComplete':False,'resourcesRetained':True}
            result=self.final_cleanup(work,record)
            self.assertTrue(result['all_closed'] and record['cleanupComplete'])
            self.assertFalse(work.exists())
            self.assertFalse(record['resourcesRetained'])
            self.assertNotIn('firstFailure',record)


if __name__=='__main__':unittest.main()
