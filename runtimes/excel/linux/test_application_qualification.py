# Copyright (c) 2026 Memlia. All rights reserved.
"""Portable preparation tests; no Docker, PostgreSQL or authenticated API claim."""
import base64
import ast
from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
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
        value['durable']=dict(jobId='workflow-execution:owned-run',executionId='owned-run',deploymentVersionId='owned-version',
                              completed=True,attempts=1,transportAcked=True,oneDelivery=True,oneExecutionLog=True)
        submission=dict(jobId='workflow-execution:owned-run',executionId='owned-run',deploymentVersionId='owned-version')
        answer=a.verify_durable_result(json.dumps(value).encode(),submission)
        self.assertTrue(answer['businessPassed'])
        self.assertNotIn('contentBase64',json.dumps(answer))
        for delta in ({'attempts':True},{'attempts':2},{'transportAcked':False},
                      {'oneDelivery':False},{'oneExecutionLog':False},{'deploymentVersionId':'other-version'},
                      {'deploymentVersionId':None}):
            changed=deepcopy(value);changed['durable'].update(delta)
            with self.subTest(delta=delta),self.assertRaises(ValueError):
                a.verify_durable_result(json.dumps(changed).encode(),submission)
        missing=deepcopy(value);del missing['durable']['deploymentVersionId']
        with self.assertRaises(ValueError):a.verify_durable_result(json.dumps(missing).encode(),submission)


class InactiveSubmissionTests(unittest.TestCase):
    def artifacts(self):
        identities=dict(workflowId='owned-workflow',workspaceId='owned-workspace',executionId='owned-run',
                        preparation=dict(expectedRevision=7,expectedStateDigest='sha256:'+'a'*64,operationId='owned-op'))
        version=dict(status='prepared_for_test',workflowId=identities['workflowId'],deploymentVersionId='inactive-version',
                     version=1,snapshotDigest='sha256:'+'b'*64,executionAvailable=False,activationAvailable=False)
        queued=dict(status='queued',workflowId=identities['workflowId'],executionId=identities['executionId'],
                    deploymentVersionId=version['deploymentVersionId'],snapshotDigest=version['snapshotDigest'])
        receipt=dict(status='passed',scope='native_session_inactive_test_submission',authenticated=True,
                     preparedForTest=True,queued=True,browserClosed=True,activationRequested=False,
                     workflowId=identities['workflowId'],workspaceId=identities['workspaceId'],executionId=identities['executionId'],
                     deploymentVersionId=version['deploymentVersionId'],snapshotDigest=version['snapshotDigest'])
        observation={k:identities[k] for k in ('workflowId','workspaceId')}
        observation.update({k:identities['preparation'][k] for k in ('expectedRevision','expectedStateDigest')})
        phase=lambda value,status:dict(status=status,raw=json.dumps(value),overflow=False)
        return receipt,identities,phase(version,200),phase(queued,202),phase(observation,200)

    def verify(self,values):
        prepared=dict(workflowId='owned-workflow',workspaceId='owned-workspace')
        return a.verify_inactive_submission(*[json.dumps(v).encode() for v in values[:1]],prepared,
                    *[json.dumps(v).encode() for v in values[1:]])

    def test_optional_inactive_profile_is_closed_and_does_not_change_the_historical_default(self):
        config=DurableConfigurationTests().config()
        self.assertEqual(a.durable_configuration(config),config)
        self.assertEqual(a.durable_configuration(config|{'journey':'inactive-test'})['journey'],'inactive-test')
        for journey in ('durable','inline',None,True,'inactive-test\n'):
            with self.subTest(journey=journey),self.assertRaises(ValueError):a.durable_configuration(config|{'journey':journey})

    def test_inactive_receipt_requires_raw_native_preparation_enqueue_and_observation_captures(self):
        values=self.artifacts();result=self.verify(values)
        self.assertEqual(result['scope'],'native_session_inactive_test_submission')
        self.assertEqual(result['jobId'],'workflow-execution:owned-run')
        self.assertEqual(result['jobIdSource'],'derived_expected')
        self.assertEqual(result['inactiveTest'],dict(workspaceId='owned-workspace',preparation=values[1]['preparation'],prepared=json.loads(values[2]['raw'])))
        self.assertNotIn('durableJobQualified',result)
        for index,delta in ((0,{'activationRequested':True}),(0,{'browserClosed':False}),(0,{'snapshotDigest':'sha256:'+'c'*64}),
                            (1,{'executionId':'foreign'}),(2,{'status':202}),(3,{'overflow':True}),(4,{'status':500})):
            changed=deepcopy(values);changed[index].update(delta)
            with self.subTest(index=index,delta=delta),self.assertRaises(ValueError):self.verify(changed)
        changed=deepcopy(values);version=json.loads(changed[2]['raw']);version['executionAvailable']=True;changed[2]['raw']=json.dumps(version)
        with self.assertRaises(ValueError):self.verify(changed)

    def test_inactive_result_requires_exact_payload_journal_and_owned_file_pins_before_qualifying(self):
        submission=self.verify(self.artifacts());value=ApplicationOracleTests().answer()
        value['scope']='native_inactive_test_compose';value['checks']['ownedRunFixtureRetired']=False
        value['durable']=dict(jobId=submission['jobId'],executionId=submission['executionId'],completed=True,attempts=1,
                              deploymentVersionId=submission['deploymentVersionId'],
                              transportAcked=True,oneDelivery=True,oneExecutionLog=True)
        value['inactive']=dict(workflowId=submission['workflowId'],workspaceId=submission['workspaceId'],executionId=submission['executionId'],
            deploymentVersionId=submission['deploymentVersionId'],snapshotDigest=submission['snapshotDigest'],versionInactive=True,
            payloadBound=True,journalVersionBound=True,resultFileBound=True)
        result=a.verify_durable_result(json.dumps(value).encode(),submission)
        self.assertTrue(result['inactiveVersionPinned']);self.assertEqual(result['scope'],value['scope'])
        for delta in ({'versionInactive':False},{'payloadBound':False},{'journalVersionBound':False},{'resultFileBound':False},
                      {'deploymentVersionId':'foreign'},{'snapshotDigest':'sha256:'+'c'*64},{'versionInactive':1}):
            changed=deepcopy(value);changed['inactive'].update(delta)
            with self.subTest(delta=delta),self.assertRaises(ValueError):a.verify_durable_result(json.dumps(changed).encode(),submission)
        del value['inactive']
        with self.assertRaises(ValueError):a.verify_durable_result(json.dumps(value).encode(),submission)

    def test_inactive_worker_start_requires_captured_proof_not_only_a_closed_browser(self):
        good=dict(browserClosedBeforeWorker=True,bootstrapPhases=['prepare','grants','verify'],
                  fixturePhases=['metadata','baseline','seed','durable-prepare','durable-publish'],
                  clientSessions=[dict(waited=True,groupClosed=True)],journey='inactive-test')
        for proof in (None,False,1):
            up,calls=DurableOrderingTests().up(good|{'inactiveSubmissionValidated':proof})
            with self.subTest(proof=proof),self.assertRaises(ValueError):up('workflow-worker')
            self.assertEqual(calls,[])
        up,calls=DurableOrderingTests().up(good|{'inactiveSubmissionValidated':True})
        up('workflow-worker');self.assertEqual(len(calls),1)

    def test_consumer_selects_the_existing_browser_profile_and_reads_each_capture_before_normalizing(self):
        # Consume the production expressions verbatim; process and protected-file IO are doubles.
        consume=next(n for n in ast.parse(Path(a.__file__).read_text()).body
                     if isinstance(n,ast.FunctionDef) and n.name=='consume_durable')
        client=next(n for n in ast.walk(consume) if isinstance(n,ast.Expr) and isinstance(n.value,ast.Call)
                    and isinstance(n.value.func,ast.Name) and n.value.func.id=='client'
                    and 'linux-chat-browser.mjs' in ast.unparse(n))
        submission=next(n for n in ast.walk(consume) if isinstance(n,ast.Assign)
                        and any(isinstance(t,ast.Name) and t.id=='submission' for t in n.targets))
        code=compile(ast.fix_missing_locations(ast.Module(body=[deepcopy(client),deepcopy(submission)],type_ignores=[])),a.__file__,'exec')
        profile=Path('/owned/profile');prepared=dict(workflowId='owned-workflow',workspaceId='owned-workspace')
        values=self.artifacts()
        raw={profile/'submission.json':json.dumps(values[0]).encode()}
        for suffix,value in zip(('test-identities','test-prepare','test-enqueue','test-observe'),values[1:]):
            raw[profile/('submission.json.'+suffix+'.private.json')]=json.dumps(value).encode()
        reads=[];calls=[]
        def read_closed(path,limit):reads.append(path);self.assertLessEqual(len(raw[path]),limit);return raw[path]
        scope=dict(inactive=True,prepared=prepared,read_closed=read_closed,profile=profile,ROOT=Path('/owned/source'),
            browser={'node':{'path':'node'},'chromium':{'path':'chromium'}},run_as=['setpriv'],client=lambda *args,**kwargs:calls.append(args[0]),
            verify_inactive_submission=a.verify_inactive_submission,verify_durable_submission=a.verify_durable_submission)
        exec(code,scope)
        self.assertIn('--inactive-test',calls[0]);self.assertNotIn('--durable',calls[0])
        self.assertEqual(len(reads),5);self.assertEqual(scope['submission']['jobIdSource'],'derived_expected')


COMPOSE_FILE=Path(__file__).resolve().parents[3]/'deploy/memlia/compose.yaml'


def compose_digest(reference):
    """Digest pinned for `repository:tag` in compose.yaml, the single source; fails loudly."""
    found=re.findall(r'^    image: '+re.escape(reference)+r'@sha256:([0-9a-f]{64})$',COMPOSE_FILE.read_text(),re.MULTILINE)
    if len(found)!=1:raise AssertionError('compose.yaml must pin exactly one '+reference)
    return found[0]


class BrowserProfilePathTests(unittest.TestCase):
    """Chromium binds TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket (run9: SIGABRT at 145 bytes)."""
    NONCE='506b45cdeefe429'+'0'*17

    def test_profile_is_short_and_its_longest_singleton_socket_fits_sun_path(self):
        profile=a.browser_profile(self.NONCE)
        self.assertEqual(profile,Path('/run/memlia-browser-'+self.NONCE[:16]))
        socket=str(profile)+'/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket'
        self.assertEqual(len(socket),85);self.assertTrue(a.browser_socket_fits(profile))

    def test_run9_layout_and_any_path_beyond_107_bytes_are_refused_before_launch(self):
        old=Path('/run/memlia-excel-host-'+'5'*32)/('browser-'+self.NONCE)
        self.assertEqual(len(str(old)+'/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket'),145)
        self.assertFalse(a.browser_socket_fits(old))
        tail=len('/tmp/org.chromium.Chromium.XXXXXX/SingletonSocket')
        self.assertTrue(a.browser_socket_fits(Path('/'+'r'*(107-tail-1))))
        self.assertFalse(a.browser_socket_fits(Path('/'+'r'*(108-tail-1))))
        self.assertFalse(a.browser_socket_fits(Path('/'+'\u00e9'*((107-tail)//2+1))))
        with mock.patch.object(a,'BROWSER_ROOT',Path('/run/'+'x'*60)),self.assertRaisesRegex(ValueError,'browser_socket_path_refused'):
            a.browser_profile(self.NONCE)
        for nonce in ('A'*32,'a'*31,None,'a'*32+'/'):
            with self.subTest(nonce=nonce),self.assertRaises(ValueError):a.browser_profile(nonce)

    def test_profile_is_created_exclusively_private_under_a_protected_parent(self):
        me=os.getuid()
        with tempfile.TemporaryDirectory() as folder:
            parent=Path(folder)/'run';parent.mkdir(mode=0o755);profile=parent/'memlia-browser-x'
            with mock.patch.object(a.os,'chown',wraps=os.chown) as chown:
                a.create_browser_profile(profile,owner=me,uid=me,gid=os.getgid())
            info=profile.lstat()
            self.assertTrue(stat.S_ISDIR(info.st_mode));self.assertEqual(stat.S_IMODE(info.st_mode),0o700)
            chown.assert_called_once_with(profile,me,os.getgid())
            with self.assertRaises(FileExistsError):a.create_browser_profile(profile,owner=me,uid=me,gid=os.getgid())
            profile.rmdir()
            # The final re-read must see the expected owner: an ineffective chown is refused.
            with mock.patch.object(a.os,'chown'),self.assertRaisesRegex(ValueError,'^browser_profile_refused$'):
                a.create_browser_profile(profile,owner=me,uid=me+1,gid=os.getgid())
            profile.rmdir()
            def swap(path,uid,gid):
                # Directory replaced by a 0700 file of the same owner between mkdir and re-read.
                path.rmdir();path.touch(mode=0o700);path.chmod(0o700)
            with mock.patch.object(a.os,'chown',side_effect=swap),self.assertRaisesRegex(ValueError,'^browser_profile_refused$'):
                a.create_browser_profile(profile,owner=me,uid=me,gid=os.getgid())
            profile.unlink()
            for mode in (0o775,0o757):
                parent.chmod(mode)
                with self.subTest(mode=oct(mode)),self.assertRaisesRegex(ValueError,'browser_profile_parent_refused'):
                    a.create_browser_profile(profile,owner=me,uid=me,gid=os.getgid())
            parent.chmod(0o755)
            with self.assertRaisesRegex(ValueError,'browser_profile_parent_refused'):a.create_browser_profile(profile,owner=os.getuid()+1,uid=os.getuid(),gid=os.getgid())
            link=Path(folder)/'link';link.symlink_to(parent)
            with self.assertRaisesRegex(ValueError,'browser_profile_parent_refused'):a.create_browser_profile(link/'p',owner=os.getuid(),uid=os.getuid(),gid=os.getgid())
            self.assertFalse(profile.exists())

    def test_singleton_template_matches_the_browser_script_and_its_working_directory(self):
        script=(a.ROOT/'scripts/ci/linux-chat-browser.mjs').read_text()
        self.assertIn("process.env.TMPDIR = path.join(process.cwd(), 'tmp')",script)
        self.assertTrue(a.CHROMIUM_SINGLETON.startswith('tmp/'))
        source=Path(a.__file__).read_text()
        self.assertIn("browser['chromium']['path']],cwd=profile)",source)
        # Margin for a dot-prefixed Chromium template (one more byte).
        profile=a.browser_profile(self.NONCE)
        self.assertLessEqual(len(os.fsencode(str(profile/a.CHROMIUM_SINGLETON)))+1,a.SUN_PATH_MAX)

    def test_profile_is_removed_only_after_a_complete_run_and_kept_otherwise(self):
        import ast
        tree=ast.parse(Path(a.__file__).read_text())
        consume=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='consume_durable')
        def removes_profile(node):
            return (isinstance(node,ast.If) and ast.unparse(node.test)=='profile.exists()'
                    and ast.unparse(node.body[0])=='remove_closed_tree(profile, tree_snapshot(profile))')
        guards=lambda node:isinstance(node,ast.Try) and any(removes_profile(c) for c in node.body)
        bodies=[n.body for n in ast.walk(consume) if hasattr(n,'body') and isinstance(n.body,list)
                and any(guards(c) for c in n.body)]
        self.assertEqual(len(bodies),1);body=bodies[0]
        index=next(i for i,c in enumerate(body) if guards(c))
        self.assertIn("'profile_removal_refused'",ast.unparse(body[index].handlers[0]))
        gate=[i for i,c in enumerate(body) if isinstance(c,ast.Expr) and ast.unparse(c).startswith('require(complete and')]
        self.assertTrue(gate and gate[0]<index)
        # Retained resources are recorded before the profile removal and refuse before the work tree is erased.
        self.assertTrue(ast.unparse(body[index-1]).startswith('if retained:'))
        self.assertTrue(ast.unparse(body[index+1]).startswith('if retained:'))
        self.assertIn('remove_closed_tree(work',ast.unparse(body[index+3]))

    def test_refused_profile_path_fails_before_any_owned_work_and_is_recorded(self):
        source=Path(a.__file__).read_text()
        self.assertLess(source.index("    profile=browser_profile(nonce);record['browserProfile']=str(profile)"),
                        source.index("    work.mkdir(mode=0o700);identity=(work.stat().st_dev,work.stat().st_ino)\n    scratch"))

    def test_durable_recipe_uses_the_short_profile_and_never_the_host_socket_directory(self):
        source=Path(a.__file__).read_text()
        self.assertIn("profile=browser_profile(nonce)",source)
        self.assertNotIn("socket.parent/('browser-'",source)
        self.assertIn("create_browser_profile(profile)",source)


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

    # Shapes observed with Docker 29.9.2 (containerd store) after `docker pull` of the
    # pinned references: RepoDigests carries repository@digest, never the tag. Digests
    # come from compose.yaml, the single source; the repository is the expected literal.
    PULLED={'db':('pgvector/pgvector',compose_digest('pgvector/pgvector:pg17')),
            'redis':('valkey/valkey',compose_digest('valkey/valkey:8.1.10-alpine'))}

    def test_compose_and_qualification_pin_the_digests_observed_on_the_build_vm(self):
        self.assertEqual(a.POSTGRES,'pgvector/pgvector:pg17@sha256:'+self.PULLED['db'][1])
        self.assertEqual(a.CACHE,'valkey/valkey:8.1.10-alpine@sha256:'+self.PULLED['redis'][1])
        # Run5 RepoDigests, compared on the first digest characters only.
        self.assertTrue(('pgvector/pgvector@sha256:'+self.PULLED['db'][1]).startswith('pgvector/pgvector@sha256:ac08538c'))
        self.assertTrue(('valkey/valkey@sha256:'+self.PULLED['redis'][1]).startswith('valkey/valkey@sha256:081c2f5c'))

    def pulled(self,name):
        repository,digest=self.PULLED[name];reference=repository+'@sha256:'+digest
        config=self.config();config['images'][name]['imageId']='sha256:'+digest
        row=dict(Id='sha256:'+digest,Os='linux',Architecture='amd64',RepoDigests=[reference],
                 RepoTags=[reference],Config=dict(Labels=None))
        return config,row

    def test_pinned_service_images_accept_the_untagged_repo_digest_docker_records(self):
        for name in ('db','redis'):
            config,row=self.pulled(name);repository,digest=self.PULLED[name]
            with self.subTest(name=name):a.verify_durable_image(row,name,config)
            other='redis' if name=='db' else 'db'
            for edit,value in (('digest',[repository+'@sha256:'+'0'*64]),
                               ('repository',['attacker/'+repository.split('/')[1]+'@sha256:'+digest]),
                               ('suffix',[repository+'-fork@sha256:'+digest]),
                               ('registry',['registry.invalid/'+repository+'@sha256:'+digest]),
                               ('tagged-never-recorded',[config['images'][name]['reference']]),
                               ('other-service',[self.PULLED[other][0]+'@sha256:'+digest]),
                               ('truncated',[repository+'@sha256:'+digest[:-1]]),
                               ('empty',[]),('absent',None)):
                changed=deepcopy(row)
                if value is None:changed.pop('RepoDigests')
                else:changed['RepoDigests']=value
                with self.subTest(name=name,edit=edit),self.assertRaises(ValueError):
                    a.verify_durable_image(changed,name,config)
            changed=deepcopy(row);changed['Id']='sha256:'+'0'*64
            with self.subTest(name=name,edit='id'),self.assertRaises(ValueError):a.verify_durable_image(changed,name,config)
            # One image may be recorded under several repositories (local mirror + Hub), in any order.
            mirror='127.0.0.1:15000/mirror/'+repository+'@sha256:'+digest
            for order in ([mirror,row['RepoDigests'][0]],[row['RepoDigests'][0],mirror]):
                changed=deepcopy(row);changed['RepoDigests']=order
                with self.subTest(name=name,order=order):a.verify_durable_image(changed,name,config)
            changed=deepcopy(row);changed['RepoDigests']=['attacker/'+repository.split('/')[1]+'@sha256:'+digest,
                                                          'registry.invalid/'+repository+'@sha256:'+digest]
            with self.subTest(name=name,edit='several-foreign'),self.assertRaises(ValueError):
                a.verify_durable_image(changed,name,config)

    def test_repo_digest_strips_only_the_tag_of_the_last_path_component(self):
        self.assertEqual(a.repo_digest(a.POSTGRES),'pgvector/pgvector@sha256:'+self.PULLED['db'][1])
        self.assertEqual(a.repo_digest(a.CACHE),'valkey/valkey@sha256:'+self.PULLED['redis'][1])
        local='127.0.0.1:15000/c'+'3'*32+'/workflow-worker@sha256:'+'d'*64
        self.assertEqual(a.repo_digest(local),local)
        for bad in ('pgvector/pgvector:pg17','a@b@sha256:'+'0'*64,'pgvector@sha256:'+'0'*64,''):
            with self.subTest(bad=bad),self.assertRaises(ValueError):a.repo_digest(bad)

    def worker_row(self,config):
        # `docker image inspect` of a workflow-worker built from workflow-worker.Dockerfile on
        # node:24.22.0-bookworm: Config.Entrypoint is inherited, Cmd is the recipe's own.
        image=config['images']['workflow-worker']
        return dict(Id=image['imageId'],Os='linux',Architecture='amd64',RepoDigests=[image['reference']],
                    Config=dict(User='1001:1001',WorkingDir='/app/apps/sim',Entrypoint=['docker-entrypoint.sh'],
                                Cmd=['bun','--no-env-file','--tsconfig-override=tsconfig.json',
                                     'scripts/memlia-workflow-worker.ts'],
                                Env=['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                                     'NODE_VERSION=24.22.0','YARN_VERSION=1.22.22','NODE_ENV=production'],
                                Labels={'org.memlia.source':config['sourceCommit'],'org.memlia.lock':config['lockSha256'],
                                        'org.memlia.durable-ci':config['nonce']},StopSignal='SIGTERM',ArgsEscaped=True))

    def test_worker_image_keeps_exactly_the_inherited_node_entrypoint_shared_with_agent_control(self):
        config=self.config();row=self.worker_row(config)
        a.verify_durable_image(row,'workflow-worker',config)
        for value in (None,[],['/bin/sh','-c'],['docker-entrypoint.sh','node'],['/usr/local/bin/docker-entrypoint.sh'],
                      'docker-entrypoint.sh',['bun']):
            changed=deepcopy(row)
            if value is None:changed['Config'].pop('Entrypoint')
            else:changed['Config']['Entrypoint']=value
            with self.subTest(entrypoint=value),self.assertRaises(ValueError):
                a.verify_durable_image(changed,'workflow-worker',config)
        for key,value in (('Cmd',['node','dist/memlia-agent-control.mjs']),('User','0:0'),('WorkingDir','/app')):
            changed=deepcopy(row);changed['Config'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):a.verify_durable_image(changed,'workflow-worker',config)

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
        for edit in ('root','inline','entrypoint','shared-role','http','foreign-image','socket','uploads','external','docker','trusted-client'):
            changed=deepcopy(model);worker=changed['services']['workflow-worker']
            if edit=='root':worker['user']='0:0'
            elif edit=='inline':worker['command']=['bun','inline.ts']
            elif edit=='entrypoint':worker['entrypoint']=['sh']
            elif edit=='shared-role':worker['environment']['DATABASE_URL']=changed['services']['web']['environment']['DATABASE_URL']
            elif edit=='http':changed['services']['web']['environment']['BETTER_AUTH_URL']='http://localhost:8443'
            elif edit=='foreign-image':worker['image']=worker['image'].replace('a'*64,'f'*64)
            elif edit=='socket':worker['volumes'][1]['read_only']=False
            elif edit=='uploads':worker['volumes'][0]['source']='other'
            elif edit=='external':changed['volumes']['uploads']['external']=True
            elif edit=='trusted-client':changed['services']['web']['environment']['AUTH_TRUSTED_PROXIES']='127.0.0.1'
            else:worker['volumes'].append(dict(type='bind',source='/var/run/docker.sock',target='/var/run/docker.sock'))
            with self.subTest(edit=edit),self.assertRaises(ValueError):a.validate_durable_model(changed,config,socket)

    def test_worker_memory_limits_accept_compose_v5_decimal_string_and_nothing_looser(self):
        config=self.config();socket=Path('/run/owned-host/host.sock')
        # `docker compose config --format json` with Compose v5.6.1 renders `4g` as this string.
        model=self.model();worker=model['services']['workflow-worker']
        worker.update(mem_limit='4294967296',memswap_limit='4294967296')
        self.assertEqual(a.validate_durable_model(model,config,socket),'https://localhost:8443')
        for key in ('mem_limit','memswap_limit'):
            for value in ('4g','4G','4096m','4294967296.0',4294967296.0,' 4294967296','4294967296\n','04294967296',
                          '+4294967296','4_294_967_296','４294967296','4294967295',4294967297,'8589934592',
                          True,None,b'4294967296',[4294967296]):
                changed=deepcopy(model)
                if value is None:changed['services']['workflow-worker'].pop(key)
                else:changed['services']['workflow-worker'][key]=value
                with self.subTest(key=key,value=value),self.assertRaises(ValueError):
                    a.validate_durable_model(changed,config,socket)

    def test_compose_bytes_is_exact_for_int_and_decimal_string(self):
        self.assertTrue(a.compose_bytes(4*1024**3,4*1024**3))
        self.assertTrue(a.compose_bytes('4294967296',4*1024**3))
        for value in ('4g','04294967296','4294967296.0',4294967296.0,True,'４294967296',' 4294967296',None):
            with self.subTest(value=value):self.assertFalse(a.compose_bytes(value,4*1024**3))
        self.assertFalse(a.compose_bytes(True,1))


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

    def finalize(self,*,complete,group_closed=True,foreign_volume=False,volume_labels=None,profile_exists=False,profile_error=None):
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
                owned_labels=labels|({'com.docker.compose.volume':'uploads'} if args[2]=='owned_uploads' else {})
                row=dict(Name=args[2],Labels=owned_labels|({'org.memlia.excel.application':'foreign'} if foreign_volume and args[0]=='volume' else {}))
                if volume_labels is not None and args[2] in volume_labels:row['Labels']=volume_labels[args[2]]
                row.update(dict(Containers={}) if args[0]=='network' else dict(Driver='local',Options={}))
                return json.dumps([row]).encode()
            return b''
        def cmd(args,**kwargs):
            nonlocal running,container
            calls.append(args)
            if args[:2]==['container','stop']:running=False
            elif args[:2]==['container','rm']:container=False
        work=mock.Mock();work.stat.return_value=type('Stat',(),dict(st_dev=1,st_ino=2))()
        profile=mock.Mock(exists=lambda:profile_exists)
        scope=dict(record=record,require=a.require,started=True,complete=complete,closed=True,
            discover=lambda:[cid],raw=raw,s=a.s,owned={cid:('workflow-worker',)},cmd=cmd,json=json,
            model={'networks':{'backend':{'name':'owned_backend'}},'volumes':{'uploads':{'name':'owned_uploads'}}},
            bootstrap_volume='owned_state',project=project,nonce=nonce,profile=profile,
            owned_resource_refusal=getattr(a,'owned_resource_refusal',None),
            work=work,identity=(1,2),tree_snapshot=lambda path:{},
            remove_closed_tree=lambda path,*args:calls.append(['tree','remove'] if path is work else ['profile','remove'])
                if path is work or profile_error is None else (_ for _ in ()).throw(profile_error),
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

    def test_unlabeled_volume_is_refused_by_name_after_removing_every_proven_owned_resource(self):
        for labels in (None,{}):
            with self.subTest(labels=labels):
                calls,record=self.finalize(complete=True,volume_labels={'owned_uploads':labels},profile_exists=True)
                self.assertIn(['network','rm','owned_backend'],calls)
                self.assertIn(['volume','rm','owned_state'],calls)
                self.assertIn(['profile','remove'],calls)
                self.assertNotIn(['volume','rm','owned_uploads'],calls)
                # The work tree stays for reconciliation; the refusal names what remains.
                self.assertNotIn(['tree','remove'],calls)
                self.assertEqual(record['retainedResources'],[dict(kind='volume',resource='uploads',code='volume_labels_missing')])
                self.assertFalse(record['cleanupComplete']);self.assertTrue(record['resourcesRetained'])
                self.assertTrue(record['finalizationFailure'])

    def test_failed_profile_removal_is_named_with_the_retained_volume(self):
        calls,record=self.finalize(complete=True,volume_labels={'owned_uploads':None},profile_exists=True,
                                   profile_error=OSError('PRIVATE_CANARY profile'))
        self.assertIn(['volume','rm','owned_state'],calls);self.assertNotIn(['tree','remove'],calls)
        self.assertEqual(record['retainedResources'],[dict(kind='volume',resource='uploads',code='volume_labels_missing'),
                                                      dict(kind='profile',resource='chromium',code='profile_removal_refused')])
        self.assertFalse(record['cleanupComplete']);self.assertTrue(record['finalizationFailure'])
        calls,record=self.finalize(complete=True,profile_exists=True,profile_error=OSError('PRIVATE_CANARY profile'))
        self.assertEqual(record['retainedResources'],[dict(kind='profile',resource='chromium',code='profile_removal_refused')])
        self.assertNotIn(['tree','remove'],calls);self.assertFalse(record['cleanupComplete'])
        self.assertNotIn('PRIVATE_CANARY',json.dumps(record['retainedResources']))

    def test_owned_resource_refusal_names_each_closed_code(self):
        owner={'com.docker.compose.project':'owned','org.memlia.excel.application':'a'*32}
        volume=dict(Name='owned_uploads',Labels=owner,Driver='local',Options=None)
        network=dict(Name='owned_backend',Labels=owner,Containers={})
        refusal=lambda kind,rows,name='owned_uploads':a.owned_resource_refusal(
            kind,rows if isinstance(rows,(bytes,str)) else json.dumps(rows).encode(),name,owner)
        self.assertIsNone(refusal('volume',[volume]))
        self.assertIsNone(refusal('volume',[volume|{'Options':{}}]))
        self.assertIsNone(refusal('network',[network],'owned_backend'))
        cases=[('network',[network|{'Containers':{'c':{}}}],'owned_backend','network_in_use'),
               ('volume',[volume|{'Driver':'nfs'}],'owned_uploads','volume_driver_refused'),
               ('volume',[volume|{'Options':{'type':'nfs'}}],'owned_uploads','volume_driver_refused'),
               ('volume',[volume|{'Name':'other_uploads'}],'owned_uploads','volume_identity_refused'),
               ('volume',[volume,volume],'owned_uploads','volume_identity_refused'),
               ('network',{'Name':'owned_backend'},'owned_backend','network_identity_refused'),
               ('volume',[],'owned_uploads','volume_identity_refused'),
               ('volume',['owned_uploads'],'owned_uploads','volume_identity_refused'),
               ('volume',b'not json','owned_uploads','volume_inspection_refused'),
               ('volume',[volume|{'Labels':None}],'owned_uploads','volume_labels_missing'),
               ('volume',[volume|{'Labels':{}}],'owned_uploads','volume_labels_missing'),
               ('volume',[volume|{'Labels':owner|{'com.docker.compose.project':'other'}}],'owned_uploads','volume_labels_foreign'),
               ('network',[network|{'Labels':['owned']}],'owned_backend','network_labels_foreign')]
        for kind,rows,name,code in cases:
            with self.subTest(code=code,rows=rows):self.assertEqual(refusal(kind,rows,name),code)

    def test_volume_of_another_project_or_run_is_never_removed(self):
        other={'com.docker.compose.project':'other','com.docker.compose.volume':'uploads','org.memlia.excel.application':'a'*32}
        for labels in (other,other|{'com.docker.compose.project':'owned','org.memlia.excel.application':'c'*32},
                       {'com.docker.compose.project':'owned','org.memlia.excel.application':'a'*32}):
            with self.subTest(labels=labels):
                calls,record=self.finalize(complete=True,volume_labels={'owned_uploads':labels})
                self.assertNotIn(['volume','rm','owned_uploads'],calls)
                self.assertIn(['volume','rm','owned_state'],calls)
                self.assertEqual(record['retainedResources'],[dict(kind='volume',resource='uploads',code='volume_labels_foreign')])
                self.assertFalse(record['cleanupComplete'])

    def test_owned_volume_is_created_with_its_labels_and_verified_before_any_mount(self):
        labels={'com.docker.compose.project':'owned','com.docker.compose.volume':'uploads','org.memlia.excel.application':'a'*32}
        def run(existing=b'',inspected=None,driver=None):
            calls=[]
            def raw(args,**kwargs):
                calls.append(['raw',*args])
                if args[:2]==['volume','ls']:return existing
                row=dict(Name='owned_uploads',Labels=labels if inspected is None else None if inspected=='null' else inspected,
                         Driver='local',Options=None)
                return json.dumps([row|(driver or {})]).encode()
            scope=dict(raw=raw,cmd=lambda args,**kwargs:calls.append(args),require=a.require,s=a.s)
            self.closure('create_owned_volume',scope)('owned_uploads',labels)
            return calls
        calls=run()
        self.assertEqual(calls[1],['volume','create','--label','com.docker.compose.project=owned',
            '--label','com.docker.compose.volume=uploads','--label','org.memlia.excel.application='+'a'*32,'owned_uploads'])
        self.assertEqual(calls[0][:3],['raw','volume','ls']);self.assertEqual(calls[2][:3],['raw','volume','inspect'])
        # Docker's create is idempotent: a pre-existing or unlabeled volume is never adopted.
        for kwargs in (dict(existing=b'owned_uploads\n'),dict(inspected='null'),dict(inspected={}),
                       dict(inspected=labels|{'com.docker.compose.project':'other'}),
                       dict(driver={'Driver':'nfs'}),dict(driver={'Options':{'type':'nfs'}})):
            with self.subTest(kwargs=kwargs),self.assertRaises(ValueError):run(**kwargs)

    def test_uploads_volume_is_labelled_before_the_first_fixture_mounts_it(self):
        consume=next(node for node in ast.parse(Path(a.__file__).read_text()).body
                     if isinstance(node,ast.FunctionDef) and node.name=='consume_durable')
        body=next(node for node in reversed(consume.body) if isinstance(node,ast.Try)).body
        calls=[(node.lineno,node.func.id,ast.unparse(node)) for statement in body for node in ast.walk(statement)
               if isinstance(node,ast.Call) and isinstance(node.func,ast.Name)]
        fixtures=[line for line,name,_ in calls if name=='fixture_phase']
        created={source:line for line,name,source in calls if name=='create_owned_volume'}
        uploads=[line for source,line in created.items() if "model['volumes']['uploads']['name']" in source
                 and "'com.docker.compose.volume': 'uploads'" in source and "'com.docker.compose.project': project" in source
                 and "'org.memlia.excel.application': nonce" in source]
        state=[line for source,line in created.items() if source.startswith('create_owned_volume(bootstrap_volume')]
        self.assertEqual(len(uploads),1);self.assertEqual(len(state),1);self.assertTrue(fixtures)
        self.assertLess(uploads[0],min(fixtures))
        bootstrap=[line for line,name,_ in calls if name=='bootstrap_phase']
        self.assertLess(state[0],min(bootstrap))


def captured_baseline(size):
    # Same shape as the fixture's baseline.json: one {table,count,digest} entry per business table.
    return json.dumps([dict(table='table_%03d'%index,count=0,digest='d'*32) for index in range(size)]).encode()


class CleanupDiagnosticTests(unittest.TestCase):
    def test_closed_cleanup_failure_projection_refuses_extra_or_unbounded_fields(self):
        value=dict(status='failed',code='fixture_cleanup_refused',stage='baseline_compare',
                   index=182,sqlstate='23503')
        baseline=captured_baseline(191)
        self.assertEqual(a.project_cleanup_failure(json.dumps(value).encode(),lambda:baseline),value)
        for delta in ({'message':'PRIVATE_CANARY'},{'stage':'PRIVATE_CANARY'},
                      {'sqlstate':'23503\n'},{'sqlstate':'private'},{'sqlstate':True},
                      {'index':True},{'index':191},{'index':-1},
                      {'stage':'native_account_deletion','index':0}):
            with self.subTest(delta=delta),self.assertRaises(ValueError):
                a.project_cleanup_failure(json.dumps(value|delta).encode(),lambda:baseline)
        raw=json.dumps(value).encode()
        for raw in (raw.replace(b'"status": "failed"',b'"status":"passed","status":"failed"'),
                    b' '*1025):
            with self.assertRaises(ValueError):a.project_cleanup_failure(raw,lambda:baseline)

    def test_compare_index_is_bounded_by_the_reference_captured_for_this_run(self):
        value=dict(status='failed',code='fixture_cleanup_refused',stage='baseline_compare',index=190,sqlstate=None)
        raw=lambda index:json.dumps(value|{'index':index}).encode()
        # The candidate reference has 191 business tables; a fixed 183 lost indexes 183-190.
        for index in (0,183,190):
            with self.subTest(index=index):
                self.assertEqual(a.project_cleanup_failure(raw(index),lambda:captured_baseline(191))['index'],index)
        for index in (191,192):
            with self.subTest(index=index),self.assertRaises(ValueError):
                a.project_cleanup_failure(raw(index),lambda:captured_baseline(191))
        # The bound follows the captured reference, never a constant.
        self.assertEqual(a.project_cleanup_failure(raw(182),lambda:captured_baseline(183))['index'],182)
        with self.assertRaises(ValueError):a.project_cleanup_failure(raw(183),lambda:captured_baseline(183))
        entry=dict(table='table_000',count=0,digest='d'*32)
        for baseline in (None,b'',b'[]',b'{}',b'null',b' '*262_145,
                         json.dumps([entry,entry]).encode(),
                         json.dumps([entry|{'table':'Bad-Name'}]).encode(),
                         json.dumps([entry|{'count':-1}]).encode(),json.dumps([entry|{'count':True}]).encode(),
                         json.dumps([entry|{'digest':'x'}]).encode(),json.dumps([entry|{'extra':1}]).encode(),
                         json.dumps([entry]*1025).encode(),
                         b'[{"table":"table_000","table":"table_001","count":0,"digest":"' + b'd'*32 + b'"}]'):
            with self.subTest(baseline=baseline[:40] if baseline else baseline),self.assertRaises(ValueError):
                a.project_cleanup_failure(raw(0),lambda:baseline)

    def test_reference_is_read_only_to_bound_an_index(self):
        reads=[]
        def missing():
            reads.append(True);raise FileNotFoundError('baseline.json')
        unindexed=dict(status='failed',code='fixture_cleanup_refused',stage='native_account_deletion',
                       index=None,sqlstate='23503')
        # A failure without index keeps its diagnostic even when the reference is absent.
        self.assertEqual(a.project_cleanup_failure(json.dumps(unindexed).encode(),missing),unindexed)
        self.assertEqual(reads,[])
        indexed=unindexed|{'stage':'baseline_compare','index':0,'sqlstate':None}
        with self.assertRaises(FileNotFoundError):a.project_cleanup_failure(json.dumps(indexed).encode(),missing)
        self.assertEqual(reads,[True])
        with self.assertRaises(ValueError):a.project_cleanup_failure(json.dumps(indexed).encode(),lambda:None)

    def run_phase(self, *, failure=None, exit_code=0, inspection_failure=False, raw=None, baseline=None):
        # Execute the real nested phase, with the Docker command/inspection boundary doubled.
        tree=ast.parse(Path(a.__file__).read_text())
        nodes=[n for parent in tree.body if isinstance(parent,ast.FunctionDef) and parent.name=='consume'
               for n in parent.body if isinstance(n,ast.FunctionDef) and n.name=='phase']
        # Another nested phase (verify_inactive_submission) exists: refuse loudly, never fall back.
        self.assertEqual(len(nodes),1,'consume.phase not found')
        node=nodes[0]
        self.assertEqual([arg.arg for arg in node.args.args],['name'],'consume.phase signature changed')
        reference=captured_baseline(191) if baseline is None else baseline
        def read_closed(path,limit):
            if path.name!='baseline.json':return raw
            self.assertEqual((path,limit),(Path('/owned/scratch/ui/baseline.json'),a.BASELINE_LIMIT))
            if isinstance(reference,Exception):raise reference
            return reference
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
                   owned=owned,require=a.require,read_closed=read_closed,BASELINE_LIMIT=a.BASELINE_LIMIT,
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
        self.assertEqual(record['cleanupFailure']['index'],3)
        self.assertNotIn('phases',record)
        self.assertEqual(calls,[])
        self.assertNotIn('PRIVATE_CANARY',json.dumps(record))

    def test_cleanup_receipt_index_follows_the_captured_reference_through_the_real_phase(self):
        receipt=lambda **delta:json.dumps(dict(status='failed',code='fixture_cleanup_refused',
            stage='baseline_compare',index=190,sqlstate=None)|delta).encode()
        record,_=self.run_phase(failure=RuntimeError('PRIVATE_CANARY'),exit_code=1,raw=receipt())
        self.assertEqual(record['cleanupFailure']['index'],190)
        record,_=self.run_phase(failure=RuntimeError('PRIVATE_CANARY'),exit_code=1,raw=receipt(),
                                baseline=captured_baseline(183))
        self.assertNotIn('cleanupFailure',record)
        missing=FileNotFoundError('PRIVATE_CANARY baseline')
        record,_=self.run_phase(failure=RuntimeError('PRIVATE_CANARY'),exit_code=1,raw=receipt(),baseline=missing)
        self.assertNotIn('cleanupFailure',record)
        self.assertEqual(record['cleanupExecution'],dict(boundary='execution',exitCode=1))
        record,_=self.run_phase(failure=RuntimeError('PRIVATE_CANARY'),exit_code=1,baseline=missing,
                                raw=receipt(stage='native_account_deletion',index=None,sqlstate='23503'))
        self.assertEqual(record['cleanupFailure'],dict(status='failed',code='fixture_cleanup_refused',
            stage='native_account_deletion',index=None,sqlstate='23503'))
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
