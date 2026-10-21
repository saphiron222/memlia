# Copyright (c) 2026 Memlia. All rights reserved.
"""Real fictitious P256/X509; DPAPI, Windows session and HTTP are explicit ports."""
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from memlia_agent import enrollment as m
from test_enrollment_state import MemoryFile, Protector

SID='S-1-5-21-1000-1001-1002-1003'
EID='10000000-0000-4000-8000-000000000001'
AID='20000000-0000-4000-8000-000000000002'
IID='30000000-0000-4000-8000-000000000003'

def make_ca():
    key=ec.generate_private_key(ec.SECP256R1())
    name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Fictitious agent issuer')])
    now=datetime.now(timezone.utc).replace(microsecond=0)
    cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
          .serial_number(1).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=60))
          .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True).sign(key,hashes.SHA256()))
    return key,cert,cert.public_bytes(serialization.Encoding.PEM)

class EnrollmentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ca_key,self.ca,self.ca_pem=make_ca()
        self.disk=MemoryFile(); self.protector=Protector()
        self.binding=m.EnrollmentBinding(installation_id='install',origin='https://memlia.invalid',
            workspace_id='space',owner_user_id='owner',enrollment_id=EID)
        self.session=lambda:SimpleNamespace(windows_sid=SID)
        self.now=int(time.time()*1000)
    def client(self,**changes):
        options=dict(binding=self.binding,tls_ca_pem=self.ca_pem,agent_ca_pem=self.ca_pem,
                     file=self.disk,protector=self.protector,session_reader=self.session,clock=lambda:self.now)
        options.update(changes);return m.EnrollmentClient(**options)

    async def test_prepare_persists_the_same_encrypted_key_before_any_post(self):
        client=self.client()
        with patch.object(m,'EnrollmentChannel',side_effect=AssertionError('no request before state')):
            self.assertEqual(client.prepare(code='c'*43,expires_at=self.now+300000),'prepared')
        state=json.loads(self.protector.unprotect(self.disk.value,context=b"test-read-port"))
        self.assertEqual(state['binding']['windowsSid'],SID)
        self.assertEqual(state['phase'],'prepared')
        self.assertNotIn(state['code'].encode(),self.disk.value)
        csr=x509.load_pem_x509_csr(state['csrPem'].encode())
        key=serialization.load_pem_private_key(state['encryptedPkcs8Pem'].encode(),state['keyPassword'].encode())
        self.assertTrue(csr.is_signature_valid)
        self.assertIsInstance(key.curve,ec.SECP256R1)
        self.assertEqual(key.public_key().public_numbers(),csr.public_key().public_numbers())
        self.assertEqual(self.client().state()['phase'],'prepared')

    async def test_status_projection_never_returns_pending_secrets(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        self.assertEqual(set(c.state()),{'phase','enrollmentId'})

    def port(self,client, *, lose_challenge=False,lose_complete=False):
        owner=self
        class Http:
            calls=[]
            def __init__(self,**options): self.options=options
            async def __aenter__(self): return self
            async def __aexit__(self,*args): return False
            async def challenge(self,body):
                # The observable storage boundary must already contain the in-flight phase.
                durable=json.loads(owner.protector.unprotect(owner.disk.value,context=b'test-read-port'))
                owner.assertEqual(durable['phase'],'challenge_in_flight')
                Http.calls.append(('challenge',dict(body)))
                if lose_challenge: raise TimeoutError('fictitious lost response')
                csr=x509.load_pem_x509_csr(body['csrPem'].encode())
                import hashlib
                spki=csr.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
                payload=dict(domain='memlia.desktop.enrollment.v1',enrollmentId=EID,organizationId=None,
                    workspaceId='space',ownerUserId='owner',installationId='install',fqdn='https://memlia.invalid',
                    windowsSid=SID,csrSha256=hashlib.sha256(body['csrPem'].encode()).hexdigest(),
                    spkiSha256=hashlib.sha256(spki).hexdigest(),challenge='h'*43,expiresAt=owner.now+300000)
                return dict(enrollmentId=EID,challengePayload=json.dumps(payload,ensure_ascii=False,separators=(',',':')),
                            expiresAt=owner.now+300000)
            async def complete(self,body):
                import base64,hashlib
                from cryptography.x509.oid import ExtendedKeyUsageOID
                durable=json.loads(owner.protector.unprotect(owner.disk.value,context=b'test-read-port'))
                owner.assertEqual(durable['phase'],'complete_in_flight')
                Http.calls.append(('complete',dict(body)))
                csr=x509.load_pem_x509_csr(body['csrPem'].encode())
                csr.public_key().verify(base64.urlsafe_b64decode(body['signature']+'=='),
                    durable['challengePayload'].encode(),ec.ECDSA(hashes.SHA256()))
                if lose_complete: raise TimeoutError('fictitious lost response')
                binding=json.loads(durable['challengePayload'])
                binding['domain']='memlia.desktop.certificate.v1'
                binding['issuanceId']=IID;binding['agentId']=AID
                digest=hashlib.sha256(json.dumps(binding,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
                now=datetime.fromtimestamp(owner.now/1000,timezone.utc).replace(microsecond=0)
                cert=(x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,AID)]))
                    .issuer_name(owner.ca.subject).public_key(csr.public_key()).serial_number(0x102)
                    .not_valid_before(now-timedelta(seconds=1)).not_valid_after(now+timedelta(days=1))
                    .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
                    .add_extension(x509.KeyUsage(digital_signature=True,content_commitment=False,key_encipherment=False,
                        data_encipherment=False,key_agreement=False,key_cert_sign=False,crl_sign=False,
                        encipher_only=None,decipher_only=None),critical=True)
                    .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]),critical=False)
                    .add_extension(x509.SubjectAlternativeName([x509.UniformResourceIdentifier('https://memlia.invalid'),
                        x509.UniformResourceIdentifier('urn:memlia:installation:install'),
                        x509.UniformResourceIdentifier('urn:memlia:binding:'+digest)]),critical=False)
                    .sign(owner.ca_key,hashes.SHA256()))
                return dict(status='issued',enrollmentId=EID,agentId=AID,issuanceId=IID,bindingDigest=digest,
                    certificate=dict(certificateSerial='0102',certificateSha256=hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest(),
                        spkiSha256=durable['spkiSha256'],certificatePem=cert.public_bytes(serialization.Encoding.PEM).decode(),
                        notBefore=int(cert.not_valid_before_utc.timestamp())*1000,
                        notAfter=int(cert.not_valid_after_utc.timestamp())*1000))
        return Http

    async def test_challenge_is_sent_only_after_durable_marker_and_proof_is_bound(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        port=self.port(c)
        with patch.object(m,'EnrollmentChannel',port):
            self.assertEqual(await c.advance(),'challenged')
        durable=json.loads(self.protector.unprotect(self.disk.value,context=b'test-read-port'))
        import base64
        csr=x509.load_pem_x509_csr(durable['csrPem'].encode())
        csr.public_key().verify(base64.urlsafe_b64decode(durable['signature']+'=='),
            durable['challengePayload'].encode(),ec.ECDSA(hashes.SHA256()))
        self.assertEqual(port.calls[0][1]['csrPem'],durable['csrPem'])
        self.assertEqual(port.calls[0][1]['windowsSid'],SID)

    async def test_prepost_commit_failure_prevents_even_transport_creation(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000);self.disk.fail=True
        with patch.object(m,'EnrollmentChannel',side_effect=AssertionError('no POST')):
            with self.assertRaises(m.EnrollmentStateError): await c.advance()

    async def test_verified_issued_identity_is_durable_before_credman_promotion(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        http=self.port(c)
        class Store:
            secret=None
            def __init__(self,**kwargs):
                self.assertions=kwargs
            def load(self): return None if Store.secret is None else bytearray(Store.secret)
            def store(self,value):
                durable=json.loads(self_protector.unprotect(self_disk.value,context=b'test-read-port'))
                self_test.assertEqual(durable['phase'],'issued_pending_activation')
                Store.secret=bytes(value)
        self_protector,self_disk,self_test=self.protector,self.disk,self
        with patch.object(m,'EnrollmentChannel',http),patch.object(m,'CurrentUserCredentialStore',Store):
            self.assertEqual(await c.advance(),'challenged')
            self.assertEqual(await c.advance(),'issued_pending_activation')
            self.assertIsNone(Store.secret)
            identity=c.activate()
            self.assertEqual(identity.agent_id,AID)
        self.assertEqual(c.state()['phase'],'active')
        active=json.loads(self.protector.unprotect(self.disk.value,context=b'test-read-port'))
        self.assertNotIn('code',active);self.assertNotIn('keyPassword',active)
        self.assertEqual(len(Store.secret),43)
        self.assertEqual([name for name,_ in http.calls],['challenge','complete'])

    async def test_lost_challenge_requires_explicit_reconciliation_with_identical_csr(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        lost=self.port(c,lose_challenge=True)
        with patch.object(m,'EnrollmentChannel',lost):
            with self.assertRaises(m.EnrollmentError): await c.advance()
            with self.assertRaises(m.EnrollmentError): await c.advance()
        self.assertEqual(c.state()['phase'],'challenge_unknown')
        resumed=self.port(c)
        with patch.object(m,'EnrollmentChannel',resumed):
            self.assertEqual(await self.client().reconcile(),'challenged')
        self.assertEqual(lost.calls[0][1],resumed.calls[0][1])
        self.assertEqual(len(lost.calls),1)

    async def test_cancelled_post_preserves_unknown_and_propagates_cancellation(self):
        import asyncio
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        class Cancel(self.port(c)):
            async def challenge(self,body): raise asyncio.CancelledError()
        with patch.object(m,'EnrollmentChannel',Cancel):
            with self.assertRaises(asyncio.CancelledError): await c.advance()
        self.assertEqual(c.state()['phase'],'challenge_unknown')

    async def test_lost_completion_reconciles_without_regenerating_proof_or_key(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        lost=self.port(c,lose_complete=True)
        with patch.object(m,'EnrollmentChannel',lost):
            await c.advance()
            with self.assertRaises(m.EnrollmentError): await c.advance()
        self.assertEqual(c.state()['phase'],'issuance_unknown')
        resumed=self.port(c)
        with patch.object(m,'EnrollmentChannel',resumed):
            self.assertEqual(await self.client().reconcile(),'issued_pending_activation')
        self.assertEqual(lost.calls[-1][1],resumed.calls[0][1])

    async def test_unknown_202_cannot_activate_or_trigger_an_automatic_second_post(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        class Unknown(self.port(c)):
            count=0
            async def complete(self,body):
                Unknown.count+=1
                return {'status':'issuance_unknown','enrollmentId':EID}
        with patch.object(m,'EnrollmentChannel',Unknown):
            await c.advance();self.assertEqual(await c.advance(),'issuance_unknown')
            with self.assertRaises(m.EnrollmentError): await c.advance()
        with self.assertRaises(m.EnrollmentError): c.activate()
        self.assertEqual(Unknown.count,1)

    async def test_sid_change_or_expiration_blocks_post_from_persisted_state(self):
        for invalid in ('sid','expiry'):
            with self.subTest(invalid=invalid):
                self.disk=MemoryFile();c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
                if invalid=='sid': c._session_reader=lambda:SimpleNamespace(windows_sid='S-1-5-21-9999')
                else: self.now+=300001
                with patch.object(m,'EnrollmentChannel',side_effect=AssertionError('no stale POST')):
                    with self.assertRaises(m.EnrollmentError): await c.advance()

    async def test_distinct_tls_and_agent_authorities_are_not_conflated(self):
        _,_,tls_ca=make_ca();c=self.client(tls_ca_pem=tls_ca)
        c.prepare(code='c'*43,expires_at=self.now+300000)
        with patch.object(m,'EnrollmentChannel',self.port(c)):
            await c.advance();self.assertEqual(await c.advance(),'issued_pending_activation')

    async def test_untrusted_agent_issuer_never_installs_a_credential(self):
        _,_,foreign=make_ca();c=self.client(agent_ca_pem=foreign)
        c.prepare(code='c'*43,expires_at=self.now+300000)
        with patch.object(m,'EnrollmentChannel',self.port(c)),patch.object(m,'CurrentUserCredentialStore',side_effect=AssertionError('no credential')):
            await c.advance()
            with self.assertRaises(m.EnrollmentError): await c.advance()
        self.assertEqual(c.state()['phase'],'issuance_unknown')

    async def test_wrong_binding_or_certificate_metadata_remains_unknown(self):
        for field in ('bindingDigest','issuanceId','spkiSha256','notAfter'):
            with self.subTest(field=field):
                self.disk=MemoryFile();c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
                class Wrong(self.port(c)):
                    async def complete(self,body):
                        result=await super().complete(body)
                        if field=='bindingDigest': result[field]='0'*64
                        elif field=='issuanceId': result[field]='40000000-0000-4000-8000-000000000004'
                        elif field=='spkiSha256': result['certificate'][field]='f'*64
                        else: result['certificate'][field]+=1000
                        return result
                with patch.object(m,'EnrollmentChannel',Wrong):
                    await c.advance()
                    with self.assertRaises(m.EnrollmentError): await c.advance()
                self.assertEqual(c.state()['phase'],'issuance_unknown')

    async def test_signed_but_wrong_certificate_extensions_are_refused(self):
        import hashlib
        from cryptography.x509.oid import ExtensionOID, ExtendedKeyUsageOID
        for kind in ('san','eku','keyusage','ca','cn','future','key'):
            with self.subTest(kind=kind):
                self.disk=MemoryFile();c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
                owner=self
                class Wrong(self.port(c)):
                    async def complete(self,body):
                        result=await super().complete(body);meta=result['certificate']
                        old=x509.load_pem_x509_certificate(meta['certificatePem'].encode())
                        key=ec.generate_private_key(ec.SECP256R1()).public_key() if kind=='key' else old.public_key()
                        builder=(x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'foreign')]) if kind=='cn' else old.subject)
                            .issuer_name(old.issuer).public_key(key).serial_number(old.serial_number)
                            .not_valid_before(old.not_valid_before_utc+timedelta(hours=1) if kind=='future' else old.not_valid_before_utc)
                            .not_valid_after(old.not_valid_after_utc))
                        for extension in old.extensions:
                            value=extension.value
                            if kind=='san' and extension.oid==ExtensionOID.SUBJECT_ALTERNATIVE_NAME:
                                value=x509.SubjectAlternativeName([x509.UniformResourceIdentifier('https://foreign.invalid')])
                            if kind=='eku' and extension.oid==ExtensionOID.EXTENDED_KEY_USAGE:
                                value=x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH])
                            if kind=='ca' and extension.oid==ExtensionOID.BASIC_CONSTRAINTS:
                                value=x509.BasicConstraints(ca=True,path_length=0)
                            if kind=='keyusage' and extension.oid==ExtensionOID.KEY_USAGE:
                                value=x509.KeyUsage(digital_signature=False,content_commitment=False,key_encipherment=True,
                                    data_encipherment=False,key_agreement=False,key_cert_sign=False,crl_sign=False,
                                    encipher_only=None,decipher_only=None)
                            builder=builder.add_extension(value,critical=extension.critical)
                        cert=builder.sign(owner.ca_key,hashes.SHA256())
                        meta.update(certificatePem=cert.public_bytes(serialization.Encoding.PEM).decode(),
                            certificateSha256=hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest(),
                            spkiSha256=hashlib.sha256(key.public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest(),
                            notBefore=int(cert.not_valid_before_utc.timestamp())*1000)
                        return result
                with patch.object(m,'EnrollmentChannel',Wrong):
                    await c.advance()
                    with self.assertRaises(m.EnrollmentError): await c.advance()
                self.assertEqual(c.state()['phase'],'issuance_unknown')

    async def test_expired_pending_activation_does_not_even_open_credman(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        with patch.object(m,'EnrollmentChannel',self.port(c)):
            await c.advance();await c.advance()
        self.now+=300001
        with patch.object(m,'CurrentUserCredentialStore') as credentials:
            with self.assertRaises(m.EnrollmentError): c.activate()
            credentials.assert_not_called()

    async def test_scope_mismatch_in_challenge_is_not_signed(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        class Foreign(self.port(c)):
            async def challenge(self,body):
                result=await super().challenge(body)
                result['challengePayload']=result['challengePayload'].replace('"owner"','"foreign"')
                return result
        with patch.object(m,'EnrollmentChannel',Foreign):
            with self.assertRaises(m.EnrollmentError): await c.advance()
        self.assertEqual(c.state()['phase'],'challenge_unknown')
        saved=json.loads(self.protector.unprotect(self.disk.value,context=b'test-read-port'))
        self.assertNotIn('signature',saved)

    async def test_commit_failure_after_remote_effect_keeps_inflight_reconcilable(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        owner=self
        class AfterEffect(self.port(c)):
            async def complete(self,body):
                result=await super().complete(body);owner.disk.fail=True;return result
        with patch.object(m,'EnrollmentChannel',AfterEffect):
            await c.advance()
            with self.assertRaises(m.EnrollmentError): await c.advance()
        self.disk.fail=False
        self.assertEqual(c.state()['phase'],'complete_in_flight')
        resumed=self.port(c)
        with patch.object(m,'EnrollmentChannel',resumed):
            self.assertEqual(await self.client().reconcile(),'issued_pending_activation')
        self.assertEqual(AfterEffect.calls[-1][1],resumed.calls[0][1])

    async def test_interrupted_promotion_never_overwrites_another_existing_secret(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        with patch.object(m,'EnrollmentChannel',self.port(c)):
            await c.advance();await c.advance()
        class ForeignStore:
            def __init__(self,**kwargs): pass
            def load(self): return bytearray(b'FICTIONAL_OTHER_IDENTITY')
            def store(self,value): raise AssertionError('must not overwrite another secret')
        with patch.object(m,'CurrentUserCredentialStore',ForeignStore):
            with self.assertRaises(m.EnrollmentError): c.activate()
        self.assertEqual(c.state()['phase'],'issued_pending_activation')

    async def test_lost_credential_write_ack_is_reconciled_locally_without_another_write(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        with patch.object(m,'EnrollmentChannel',self.port(c)):
            await c.advance();await c.advance()
        class Store:
            secret=None;writes=0
            def __init__(self,**kwargs): pass
            def load(self): return None if Store.secret is None else bytearray(Store.secret)
            def store(self,value):
                Store.writes+=1;Store.secret=bytes(value);raise OSError('lost fictitious acknowledgement')
        with patch.object(m,'CurrentUserCredentialStore',Store):
            with self.assertRaises(m.EnrollmentError): c.activate()
            self.assertEqual(c.state()['phase'],'issued_pending_activation')
            self.assertEqual(c.activate().agent_id,AID)
            self.now+=300001
            self.assertEqual(c.activate().agent_id,AID)
        self.assertEqual(c.state()['phase'],'active');self.assertEqual(Store.writes,1)

    async def test_expired_pending_status_is_visible_without_exposing_its_code(self):
        c=self.client();c.prepare(code='c'*43,expires_at=self.now+300000)
        self.now+=300000
        self.assertEqual(c.state(),{'phase':'expired','enrollmentId':EID})
