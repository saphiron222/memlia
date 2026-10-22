# Copyright (c) 2026 Memlia. All rights reserved.
"""Bounded DPAPI state and owned Windows NTFS persistence; not agent authority."""
from __future__ import annotations
import ctypes
import json
import re
import secrets
import sys
from pathlib import PureWindowsPath

from .user_secrets import CurrentUserProtector, _wipe
from .transport import _json

MAX_CLEAR=65536
MAX_PROTECTED=98304

class EnrollmentStateError(RuntimeError):
    def __init__(self,code): self.code=code; super().__init__(code)

class ProtectedEnrollmentState:
    """The file port atomically compares/replaces opaque protected bytes.

    Production uses WindowsEnrollmentFile. A supplied protector is the DPAPI port,
    not an alternative public credential provider; tests may double native Windows.
    """
    def __init__(self, *, file, context: bytes, protector=None):
        if type(context) is not bytes or not 1<=len(context)<=1024:
            raise EnrollmentStateError('invalid_state_context')
        self._file=file; self._context=context
        self._protector=protector if protector is not None else CurrentUserProtector(
            max_secret_bytes=MAX_CLEAR,max_protected_bytes=MAX_PROTECTED,max_context_bytes=1024)

    def _decode(self, blob):
        clear=None; result=None
        try:
            if type(blob) is not bytes or not 1<=len(blob)<=MAX_PROTECTED: raise ValueError()
            clear=self._protector.unprotect(blob,context=self._context)
            if type(clear) is not bytearray or not 1<=len(clear)<=MAX_CLEAR: raise ValueError()
            value=_json(clear)
            if (type(value) is not dict or type(value.get('version')) is not int or value['version']!=1
                or type(value.get('revision')) is not int or not 0<=value['revision']<2**53): raise ValueError()
            result=value
        except Exception: result=None
        finally:
            if type(clear) is bytearray: _wipe(clear)
        if result is None: raise EnrollmentStateError('state_unreadable')
        return result

    def load(self):
        blob=self._file.read()
        return None if blob is None else self._decode(blob)

    def commit(self,value, *, expected_revision):
        previous=self._file.read()
        old=None if previous is None else self._decode(previous)
        if (expected_revision is not None and type(expected_revision) is not int
            or old is None and expected_revision is not None
            or old is not None and old['revision']!=expected_revision):
            raise EnrollmentStateError('state_conflict')
        clear=None; protected=None
        try:
            if (type(value) is not dict or type(value.get('version')) is not int or value['version']!=1
                or type(value.get('revision')) is not int or not 0<=value['revision']<2**53
                or value['revision']!=(0 if old is None else old['revision']+1)):
                raise ValueError()
            clear=bytearray(json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode())
            if not 1<=len(clear)<=MAX_CLEAR: raise ValueError()
            protected=self._protector.protect(clear,context=self._context)
            if type(protected) is not bytes or not 1<=len(protected)<=MAX_PROTECTED: raise ValueError()
        except Exception: protected=None
        finally:
            if type(clear) is bytearray: _wipe(clear)
        if protected is None: raise EnrollmentStateError('state_write_refused')
        try: self._file.replace(protected,previous)
        except EnrollmentStateError: raise
        except Exception: raise EnrollmentStateError('state_commit_unknown') from None
        # Acknowledgement is usable only after rereading the exact committed bytes.
        if self._file.read()!=protected: raise EnrollmentStateError('state_commit_unknown')
        return self._decode(protected)

class WindowsEnrollmentFile:
    """Single-user, non-roaming NTFS file; no caller-selected directory or filename.

    Native ACL/reparse/durability semantics require Windows qualification. A local
    administrator or another process of the same user is not an isolation boundary.
    """
    def __init__(self, *, context_digest: str,windows_sid: str):
        if sys.platform!='win32': raise EnrollmentStateError('unsupported_platform')
        if (type(context_digest) is not str or not re.fullmatch('[a-f0-9]{64}',context_digest)
            or type(windows_sid) is not str or len(windows_sid)>184
            or not re.fullmatch(r'S-1-\d+(?:-\d+){1,14}',windows_sid,re.ASCII)):
            raise EnrollmentStateError('invalid_state_identity')
        self._name='enrollment-'+context_digest
        self._sid=windows_sid

    def read(self): return self._operation(None,None,False)
    def replace(self,value,expected):
        if (type(value) is not bytes or not 1<=len(value)<=MAX_PROTECTED
            or expected is not None and (type(expected) is not bytes or len(expected)>MAX_PROTECTED)):
            raise EnrollmentStateError('invalid_state_blob')
        self._operation(value,expected,True)

    def _operation(self,value,expected,write):
        result=None;failure=None
        try:
            with _WindowsFiles(self._sid) as native:
                native.lock(self._name+'.lock')
                result=native.read(self._name+'.bin')
                if write:
                    if result!=expected: raise EnrollmentStateError('state_conflict')
                    native.replace(self._name+'.bin',value)
        except EnrollmentStateError: raise
        except Exception: failure='state_commit_unknown' if write else 'state_unreadable'
        if failure: raise EnrollmentStateError(failure)
        return result

class _SecurityAttributes(ctypes.Structure):
    _fields_=[('length',ctypes.c_uint32),('descriptor',ctypes.c_void_p),('inherit',ctypes.c_int)]

class _FileInformation(ctypes.Structure):
    _fields_=[('attributes',ctypes.c_uint32),('creation',ctypes.c_uint32*2),
              ('access',ctypes.c_uint32*2),('write',ctypes.c_uint32*2),
              ('volume',ctypes.c_uint32),('size_high',ctypes.c_uint32),('size_low',ctypes.c_uint32),
              ('links',ctypes.c_uint32),('index_high',ctypes.c_uint32),('index_low',ctypes.c_uint32)]

class _WindowsFiles:
    """Win32-only bounded adapter. Every handle/path remains in the owned profile.

    All DLLs resolve from System32. Handles deny delete sharing while paths are
    pinned; the exclusive file lock serializes cooperating Memlia processes.
    """
    def __init__(self,sid):
        if sys.platform!='win32': raise EnrollmentStateError('unsupported_platform')
        self._sid=sid;self._handles=[];self._descriptor=ctypes.c_void_p();self._temporary=None
        self._expected='O:'+sid+'D:P(A;;FA;;;'+sid+')'
        p=ctypes.c_void_p;u=ctypes.c_uint32
        self.k=ctypes.WinDLL('kernel32',use_last_error=True,winmode=0x800)
        self.a=ctypes.WinDLL('advapi32',use_last_error=True,winmode=0x800)
        self.s=ctypes.WinDLL('shell32',use_last_error=True,winmode=0x800)
        self.o=ctypes.WinDLL('ole32',use_last_error=True,winmode=0x800)
        specs=[(self.k,'CreateFileW',p,[ctypes.c_wchar_p,u,u,p,u,u,p]),
            (self.k,'CloseHandle',ctypes.c_int,[p]),(self.k,'LocalFree',p,[p]),
            (self.k,'CreateDirectoryW',ctypes.c_int,[ctypes.c_wchar_p,p]),
            (self.k,'GetFileInformationByHandle',ctypes.c_int,[p,ctypes.POINTER(_FileInformation)]),
            (self.k,'ReadFile',ctypes.c_int,[p,p,u,ctypes.POINTER(u),p]),
            (self.k,'WriteFile',ctypes.c_int,[p,p,u,ctypes.POINTER(u),p]),
            (self.k,'FlushFileBuffers',ctypes.c_int,[p]),
            (self.k,'MoveFileExW',ctypes.c_int,[ctypes.c_wchar_p,ctypes.c_wchar_p,u]),
            (self.k,'DeleteFileW',ctypes.c_int,[ctypes.c_wchar_p]),
            (self.k,'GetDriveTypeW',u,[ctypes.c_wchar_p]),
            (self.k,'GetVolumeInformationW',ctypes.c_int,[ctypes.c_wchar_p,p,u,p,p,p,ctypes.c_wchar_p,u]),
            (self.a,'ConvertStringSecurityDescriptorToSecurityDescriptorW',ctypes.c_int,
                [ctypes.c_wchar_p,u,ctypes.POINTER(p),p]),
            (self.a,'ConvertSecurityDescriptorToStringSecurityDescriptorW',ctypes.c_int,
                [p,u,u,ctypes.POINTER(p),p]),
            (self.a,'GetSecurityInfo',u,[p,ctypes.c_int,u,p,p,p,p,ctypes.POINTER(p)]),
            (self.s,'SHGetKnownFolderPath',ctypes.c_int,[p,u,p,ctypes.POINTER(p)]),
            (self.o,'CoTaskMemFree',None,[p])]
        for dll,name,result,args in specs:
            f=getattr(dll,name);f.restype=result;f.argtypes=args

    def _check(self,value):
        if not value: raise EnrollmentStateError('state_native_refused')
        return value

    def _path(self,path): return '\\\\?\\'+str(path)

    def _sddl(self,handle,private):
        descriptor=ctypes.c_void_p();text=ctypes.c_void_p();flags=5 if private else 1
        try:
            self._check(self.a.GetSecurityInfo(handle,1,flags,None,None,None,None,ctypes.byref(descriptor))==0)
            self._check(self.a.ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,1,flags,ctypes.byref(text),None))
            self._check(ctypes.wstring_at(text)==(self._expected if private else 'O:'+self._sid))
        finally:
            if text.value: self._check(not self.k.LocalFree(text))
            if descriptor.value: self._check(not self.k.LocalFree(descriptor))

    def _open(self,path,*,directory=False,private=False,access=0,share=3,disposition=3,missing=False):
        attrs=0x00200000|(0x02000000 if directory else 0) # OPEN_REPARSE_POINT / BACKUP_SEMANTICS
        sa=_SecurityAttributes(ctypes.sizeof(_SecurityAttributes),self._descriptor,False)
        h=self.k.CreateFileW(self._path(path),access|(0x20000 if private else 0),share,
            ctypes.byref(sa) if disposition in (1,4) else None,disposition,attrs,None)
        if h==ctypes.c_void_p(-1).value or h is None:
            if missing and ctypes.get_last_error()==2: return None
            raise EnrollmentStateError('state_file_unavailable')
        self._handles.append(h)
        info=_FileInformation();self._check(self.k.GetFileInformationByHandle(h,ctypes.byref(info)))
        self._check(not info.attributes&0x400 and bool(info.attributes&0x10)==directory)
        if not directory: self._check(info.links==1 and info.size_high==0 and info.size_low<=MAX_PROTECTED)
        if private: self._sddl(h,True)
        return h

    def _close(self,h):
        self._check(self.k.CloseHandle(h));self._handles.remove(h)

    def _fixed_ntfs(self,anchor):
        # A mapped network volume may advertise NTFS; filesystem capabilities
        # alone do not establish the local fixed-drive persistence profile.
        self._check(self.k.GetDriveTypeW(anchor)==3)  # DRIVE_FIXED
        fs=ctypes.create_unicode_buffer(16)
        self._check(self.k.GetVolumeInformationW(anchor,None,0,None,None,None,fs,16))
        self._check(fs.value=='NTFS')

    def __enter__(self):
        import uuid
        folder=ctypes.c_void_p()
        try:
            # FOLDERID_LocalAppData, current user, no environment/PATH lookup.
            guid=(ctypes.c_ubyte*16).from_buffer_copy(uuid.UUID('F1B32785-6FBA-4FCF-9D55-7B8E7F157091').bytes_le)
            self._check(self.s.SHGetKnownFolderPath(guid,0,None,ctypes.byref(folder))==0)
            base=PureWindowsPath(ctypes.wstring_at(folder))
        finally:
            if folder.value: self.o.CoTaskMemFree(folder)
        try:
            self._check(len(str(base))<4096 and re.fullmatch('[A-Za-z]:',base.drive)
                        and base.is_absolute() and '..' not in base.parts)
            self._fixed_ntfs(base.anchor)
            self._check(self.a.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                self._expected,1,ctypes.byref(self._descriptor),None))
            self._check(len(base.parts)<=32)
            for parent in [*reversed(base.parents),base]:
                self._open(parent,directory=True)
            # Only the profile directory owner is required here; its system ACL is left intact.
            owner_handle=self.k.CreateFileW(self._path(base),0x20000,3,None,3,0x02200000,None)
            self._check(owner_handle and owner_handle!=ctypes.c_void_p(-1).value)
            self._handles.append(owner_handle);self._sddl(owner_handle,False)
            self.root=base/'MemliaEnrollment-v1'
            sa=_SecurityAttributes(ctypes.sizeof(_SecurityAttributes),self._descriptor,False)
            if not self.k.CreateDirectoryW(self._path(self.root),ctypes.byref(sa)):
                self._check(ctypes.get_last_error()==183)
            self._open(self.root,directory=True,private=True)
            return self
        except BaseException:
            self.__exit__(None,None,None);raise

    def __exit__(self,*args):
        failed=False
        for h in self._handles[::-1]:
            if not self.k.CloseHandle(h): failed=True
        self._handles=[]
        if self._descriptor.value and self.k.LocalFree(self._descriptor): failed=True
        self._descriptor=ctypes.c_void_p()
        if failed: raise EnrollmentStateError('state_cleanup_unknown')

    def lock(self,name):
        self._open(self.root/name,private=True,access=0xC0000000,share=0,disposition=4)

    def read(self,name):
        h=self._open(self.root/name,private=True,access=0x80000000,share=1,missing=True)
        if h is None: return None
        try:
            data=ctypes.create_string_buffer(MAX_PROTECTED+1);size=ctypes.c_uint32()
            self._check(self.k.ReadFile(h,data,MAX_PROTECTED+1,ctypes.byref(size),None))
            self._check(0<size.value<=MAX_PROTECTED)
            return data.raw[:size.value]
        finally: self._close(h)

    def replace(self,name,value):
        temporary=self.root/(name+'.'+secrets.token_hex(16)+'.tmp')
        h=self._open(temporary,private=True,access=0x40000000,share=0,disposition=1)
        moved=False
        try:
            data=ctypes.create_string_buffer(value);size=ctypes.c_uint32()
            self._check(self.k.WriteFile(h,data,len(value),ctypes.byref(size),None))
            self._check(size.value==len(value));self._check(self.k.FlushFileBuffers(h))
            self._close(h);h=None
            # Same-directory NTFS replacement, no cross-volume copy or reboot flags.
            self._check(self.k.MoveFileExW(self._path(temporary),self._path(self.root/name),1|8))
            moved=True
        finally:
            if h is not None: self._close(h)
            if not moved: self._check(self.k.DeleteFileW(self._path(temporary)))
