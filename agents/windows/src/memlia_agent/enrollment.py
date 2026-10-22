# Copyright (c) 2026 Memlia. All rights reserved.
"""One-shot enrollment with durable state, existing DPAPI/CredMan and no retry loop."""
from __future__ import annotations
import asyncio
import base64
from dataclasses import dataclass, field
import hashlib
import hmac
import json
import re
import secrets
import time
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID, ExtensionOID
from .client_identity import ClientIdentity
from .enrollment_state import ProtectedEnrollmentState, EnrollmentStateError
from .session import observe_session
from .transport import EnrollmentChannel, _origin, _json, _enrollment_result
from .user_credentials import CurrentUserCredentialStore
from .user_secrets import _wipe

_ID=re.compile(r'[A-Za-z0-9_-]{1,128}',re.ASCII)
_UUID=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',re.ASCII)
_SID=re.compile(r'S-1-\d+(?:-\d+){1,14}',re.ASCII)
_CODE=re.compile(r'[A-Za-z0-9_-]{43}',re.ASCII)
_PHASES={'prepared','challenge_in_flight','challenge_unknown','challenged',
         'complete_in_flight','issuance_unknown','issued_pending_activation','active'}

def _sha(value): return hashlib.sha256(value).hexdigest()
def _canonical(value): return json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8')
def _ms(value): return int(value.timestamp())*1000

def _require(value):
    if not value: raise EnrollmentError('enrollment_refused')

class EnrollmentError(RuntimeError):
    def __init__(self,code): self.code=code;super().__init__(code)

@dataclass(frozen=True,kw_only=True)
class EnrollmentBinding:
    installation_id: str = field(repr=False)
    origin: str = field(repr=False)
    workspace_id: str = field(repr=False)
    owner_user_id: str = field(repr=False)
    enrollment_id: str = field(repr=False)
    def __post_init__(self):
        _require(all(type(v) is str and _ID.fullmatch(v) for v in
            (self.installation_id,self.workspace_id,self.owner_user_id,self.enrollment_id)))
        _require(self.installation_id[0].isalnum() and _UUID.fullmatch(self.enrollment_id))
        _require(_origin(self.origin)==self.origin)

class EnrollmentClient:
    """Trusted local composition, not an HTTP/UI authority boundary.

    Native defaults are mandatory in production. File/protector/session/clock ports
    allow isolated tests; none may come from a remote command or model output.
    No method starts a capture, executes a workflow or creates a browser Principal.
    """
    def __init__(self, *, binding: EnrollmentBinding, tls_ca_pem: bytes, agent_ca_pem: bytes,
                 file=None,protector=None,session_reader=observe_session,clock=None):
        _require(type(binding) is EnrollmentBinding)
        self._session_reader=session_reader;self._clock=clock or (lambda:int(time.time()*1000))
        self._binding={'installationId':binding.installation_id,'fqdn':binding.origin,
            'workspaceId':binding.workspace_id,'ownerUserId':binding.owner_user_id,
            'enrollmentId':binding.enrollment_id,'windowsSid':session_reader().windows_sid}
        sid=self._binding['windowsSid']
        _require(type(sid) is str and len(sid)<=184 and _SID.fullmatch(sid))
        for value in (tls_ca_pem,agent_ca_pem): _require(type(value) is bytes and 1<=len(value)<=32768)
        self._tls_ca=tls_ca_pem;self._agent_ca=agent_ca_pem
        self._ca_hashes={'tlsCaSha256':_sha(tls_ca_pem),'agentCaSha256':_sha(agent_ca_pem)}
        context=b'Memlia.EnrollmentState.v1\0'+hashlib.sha256(_canonical({**self._binding,**self._ca_hashes})).digest()
        if file is None:
            from .enrollment_state import WindowsEnrollmentFile
            file=WindowsEnrollmentFile(context_digest=_sha(context),windows_sid=sid)
        self._store=ProtectedEnrollmentState(file=file,context=context,protector=protector)

    def _session(self):
        _require(self._session_reader().windows_sid==self._binding['windowsSid'])

    def _read(self):
        value=self._store.load()
        if value is None: return None
        _require(value.get('binding')==self._binding and value.get('authorities')==self._ca_hashes
                 and value.get('phase') in _PHASES)
        return value

    def state(self):
        value=self._read()
        if value is None: return None
        phase=value['phase']
        if phase!='active' and self._clock()>=value['expiresAt']: phase='expired'
        return {'phase':phase,'enrollmentId':self._binding['enrollmentId']}

    def prepare(self, *, code: str,expires_at: int):
        self._session();_require(self._read() is None)
        _require(type(code) is str and _CODE.fullmatch(code))
        _require(type(expires_at) is int and self._clock()<expires_at<=self._clock()+300000)
        key=ec.generate_private_key(ec.SECP256R1())
        password=base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=')
        csr=x509.CertificateSigningRequestBuilder().subject_name(x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME,'memlia-pending:'+self._binding['enrollmentId'])
        ])).sign(key,hashes.SHA256()).public_bytes(serialization.Encoding.PEM)
        encrypted=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,
                                   serialization.BestAvailableEncryption(password))
        spki=key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
        value={'version':1,'revision':0,'phase':'prepared','binding':dict(self._binding),
            'authorities':dict(self._ca_hashes),'code':code,'expiresAt':expires_at,
            'encryptedPkcs8Pem':encrypted.decode('ascii'),'keyPassword':password.decode('ascii'),
            'csrPem':csr.decode('ascii'),'csrSha256':_sha(csr),'spkiSha256':_sha(spki)}
        self._store.commit(value,expected_revision=None)
        return 'prepared'

    def _transition(self,value,phase,**changes):
        next_value={**value,**changes,'phase':phase,'revision':value['revision']+1}
        return self._store.commit(next_value,expected_revision=value['revision'])

    def _validate_challenge(self,value,response):
        _enrollment_result('challenge',self._binding['enrollmentId'],200,response)
        _require(response['expiresAt']==value['expiresAt'])
        parsed=_json(response['challengePayload'].encode('utf-8'))
        names=('domain','enrollmentId','organizationId','workspaceId','ownerUserId','installationId',
               'fqdn','windowsSid','csrSha256','spkiSha256','challenge','expiresAt')
        _require(type(parsed) is dict and tuple(parsed)==names)
        expected={'domain':'memlia.desktop.enrollment.v1',**self._binding,
                  'csrSha256':value['csrSha256'],'spkiSha256':value['spkiSha256'],'expiresAt':value['expiresAt']}
        _require(all(parsed.get(k)==v and type(parsed.get(k)) is type(v) for k,v in expected.items()))
        _require(parsed['organizationId'] is None or type(parsed['organizationId']) is str
                 and _ID.fullmatch(parsed['organizationId']))
        _require(type(parsed['challenge']) is str and _CODE.fullmatch(parsed['challenge']))
        _require(_canonical(parsed)==response['challengePayload'].encode('utf-8'))
        key=serialization.load_pem_private_key(value['encryptedPkcs8Pem'].encode('ascii'),
                                              value['keyPassword'].encode('ascii'))
        _require(isinstance(key,ec.EllipticCurvePrivateKey) and isinstance(key.curve,ec.SECP256R1))
        spki=key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
        _require(_sha(spki)==value['spkiSha256'] and _sha(value['csrPem'].encode())==value['csrSha256'])
        signature=key.sign(response['challengePayload'].encode(),ec.ECDSA(hashes.SHA256()))
        return base64.urlsafe_b64encode(signature).rstrip(b'=').decode('ascii')

    def _unknown(self,value,stage):
        try: self._transition(value,'challenge_unknown' if stage=='challenge' else 'issuance_unknown')
        except Exception: pass  # The durable in-flight marker still forbids automatic replay.

    async def advance(self):
        value=self._read();_require(value is not None)
        if value['phase'] in ('prepared','challenged'):
            return await self._exchange(value,'challenge' if value['phase']=='prepared' else 'complete')
        raise EnrollmentError('reconciliation_required')

    async def reconcile(self):
        value=self._read();_require(value is not None)
        if value['phase'] in ('challenge_in_flight','challenge_unknown'):
            return await self._exchange(value,'challenge')
        if value['phase'] in ('complete_in_flight','issuance_unknown'):
            return await self._exchange(value,'complete')
        raise EnrollmentError('reconciliation_refused')

    async def _exchange(self,value,stage):
        self._session();_require(self._clock()<value['expiresAt'])
        value=self._transition(value,stage+'_in_flight')
        # This marker and all request material are durable before constructing HTTPX.
        body={k:value[k] for k in ('code','csrPem')}
        body['enrollmentId']=self._binding['enrollmentId']
        body['windowsSid' if stage=='challenge' else 'signature']=(self._binding['windowsSid']
            if stage=='challenge' else value['signature'])
        failed=False
        try:
            async with EnrollmentChannel(origin=self._binding['fqdn'],ca_pem=self._tls_ca,
                    max_response_bytes=65536,total_timeout_seconds=15,max_connections=1) as channel:
                response=await (channel.challenge(body) if stage=='challenge' else channel.complete(body))
            self._session()
            if stage=='challenge':
                signature=self._validate_challenge(value,response)
                self._transition(value,'challenged',challengePayload=response['challengePayload'],signature=signature)
                return 'challenged'
            return self._complete(value,response)
        except asyncio.CancelledError:
            self._unknown(value,stage);raise
        except Exception:
            failed=True
        if failed:
            self._unknown(value,stage)
            raise EnrollmentError('enrollment_outcome_unknown')

    def _verify_certificate(self,value,result):
        _enrollment_result('complete',self._binding['enrollmentId'],200,result)
        _require(_UUID.fullmatch(result['agentId']) and _UUID.fullmatch(result['issuanceId']))
        payload=_json(value['challengePayload'].encode('utf-8'))
        expected={**payload,'domain':'memlia.desktop.certificate.v1',
                  'issuanceId':result['issuanceId'],'agentId':result['agentId']}
        digest=_sha(_canonical(expected))
        _require(hmac.compare_digest(digest,result['bindingDigest']))
        chain=x509.load_pem_x509_certificates(result['certificate']['certificatePem'].encode('ascii'))
        authorities=x509.load_pem_x509_certificates(self._agent_ca)
        _require(len(chain)==len(authorities)==1)
        cert,ca=chain[0],authorities[0]
        cert.verify_directly_issued_by(ca)
        _require(ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca)
        _require(not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca)
        _require(cert.subject==x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,result['agentId'])]))
        _require(list(cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value)==
                 [ExtendedKeyUsageOID.CLIENT_AUTH])
        usage=cert.extensions.get_extension_for_class(x509.KeyUsage).value
        _require(usage.digital_signature and not any((usage.content_commitment,usage.key_encipherment,
                  usage.data_encipherment,usage.key_agreement,usage.key_cert_sign,usage.crl_sign)))
        sans=list(cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value)
        _require(sans==[x509.UniformResourceIdentifier(self._binding['fqdn']),
            x509.UniformResourceIdentifier('urn:memlia:installation:'+self._binding['installationId']),
            x509.UniformResourceIdentifier('urn:memlia:binding:'+digest)])
        known={ExtensionOID.BASIC_CONSTRAINTS,ExtensionOID.KEY_USAGE,ExtensionOID.EXTENDED_KEY_USAGE,
               ExtensionOID.SUBJECT_ALTERNATIVE_NAME,ExtensionOID.SUBJECT_KEY_IDENTIFIER,ExtensionOID.AUTHORITY_KEY_IDENTIFIER}
        _require(all(not extension.critical or extension.oid in known for extension in cert.extensions))
        public=cert.public_key()
        _require(isinstance(public,ec.EllipticCurvePublicKey) and isinstance(public.curve,ec.SECP256R1))
        spki=public.public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
        meta=result['certificate']; now=self._clock()
        _require(_sha(spki)==value['spkiSha256']==meta['spkiSha256']
                 and _sha(cert.public_bytes(serialization.Encoding.DER))==meta['certificateSha256']
                 and cert.serial_number==int(meta['certificateSerial'],16))
        before,after=_ms(cert.not_valid_before_utc),_ms(cert.not_valid_after_utc)
        _require(before==meta['notBefore'] and after==meta['notAfter'] and before<=now<after
                 and 0<after-before<=30*86400000
                 and _ms(ca.not_valid_before_utc)<=before<after<=_ms(ca.not_valid_after_utc))
        return cert

    def _complete(self,value,response):
        if type(response) is dict and response.get('status')=='issuance_unknown':
            _enrollment_result('complete',self._binding['enrollmentId'],202,response)
            self._transition(value,'issuance_unknown')
            return 'issuance_unknown'
        self._verify_certificate(value,response)
        self._transition(value,'issued_pending_activation',result=response)
        return 'issued_pending_activation'

    def activate(self):
        self._session();value=self._read();_require(value is not None)
        _require(value['phase'] in ('issued_pending_activation','active'))
        if value['phase']=='issued_pending_activation': _require(self._clock()<value['expiresAt'])
        failure=None;password=None;existing=None
        try:
            self._verify_certificate(value,value['result'])
            result=value['result']
            store=CurrentUserCredentialStore(instance_id=self._binding['installationId'],agent_id=result['agentId'])
            existing=store.load()
            if value['phase']=='issued_pending_activation':
                password=bytearray(value['keyPassword'].encode('ascii'))
                _require(existing is None or type(existing) is bytearray and hmac.compare_digest(existing,password))
                if existing is None: store.store(password)
                if type(existing) is bytearray: _wipe(existing)
                existing=store.load()
                _require(type(existing) is bytearray and hmac.compare_digest(existing,password))
            else: _require(type(existing) is bytearray and 1<=len(existing)<=2048)
            key=serialization.load_pem_private_key(value['encryptedPkcs8Pem'].encode('ascii'),existing)
            spki=key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
            _require(_sha(spki)==value['spkiSha256'])
            identity=ClientIdentity(instance_id=self._binding['installationId'],agent_id=result['agentId'],
                certificate_chain_pem=result['certificate']['certificatePem'].encode('ascii')+self._agent_ca,
                encrypted_pkcs8_pem=value['encryptedPkcs8Pem'].encode('ascii'))
            if value['phase']!='active':
                active={k:v for k,v in value.items() if k not in ('code','keyPassword')}
                self._transition(active,'active')
            return identity
        except Exception: failure='activation_unconfirmed'
        finally:
            if type(password) is bytearray: _wipe(password)
            if type(existing) is bytearray: _wipe(existing)
        if failure: raise EnrollmentError(failure)
