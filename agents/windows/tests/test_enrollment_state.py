# Copyright (c) 2026 Memlia. All rights reserved.
"""DPAPI/file ports are doubled here; this is not native Windows qualification."""
import copy
import hashlib
import unittest
from memlia_agent import enrollment_state as state

class MemoryFile:
    def __init__(self): self.value=None; self.fail=False; self.read_corrupt=False
    def read(self): return self.value if not self.read_corrupt else b'corrupt'
    def replace(self, value, expected):
        if self.fail: raise OSError('fictitious storage failure')
        if self.value != expected: raise state.EnrollmentStateError('state_conflict')
        self.value=value

class Protector:
    def __init__(self): self.values={}; self.contexts=[]
    def protect(self, value, *, context):
        self.contexts.append(context)
        key=hashlib.sha256(context+value).digest(); self.values[key]=bytes(value); return key
    def unprotect(self, value, *, context):
        self.contexts.append(context)
        if value not in self.values: raise ValueError()
        return bytearray(self.values[value])

class EnrollmentStateTests(unittest.TestCase):
    def test_protected_commit_is_reloaded_before_it_can_be_used(self):
        disk=MemoryFile(); protector=Protector()
        store=state.ProtectedEnrollmentState(file=disk, context=b'owned-context', protector=protector)
        value={'version':1,'revision':0,'phase':'prepared','secret':'FICTIONAL_SECRET'}
        self.assertEqual(store.commit(value, expected_revision=None),value)
        self.assertNotIn(b'FICTIONAL_SECRET',disk.value)
        self.assertEqual(store.load(),value)
        self.assertEqual(protector.contexts,[b'owned-context']*3)

    def test_overlarge_protected_blob_is_never_committed(self):
        disk=MemoryFile(); protector=Protector()
        protector.protect=lambda *a,**k:b'x'*(state.MAX_PROTECTED+1)
        store=state.ProtectedEnrollmentState(file=disk,context=b'owned',protector=protector)
        with self.assertRaises(state.EnrollmentStateError):
            store.commit({'version':1,'revision':0},expected_revision=None)
        self.assertIsNone(disk.value)

    def test_revision_conflict_cannot_replace_the_original_document(self):
        disk=MemoryFile();store=state.ProtectedEnrollmentState(file=disk,context=b'owned',protector=Protector())
        value={'version':1,'revision':0,'phase':'prepared'}
        store.commit(value,expected_revision=None);before=disk.value
        with self.assertRaises(state.EnrollmentStateError):
            store.commit({'version':1,'revision':1},expected_revision=None)
        self.assertEqual(disk.value,before)

    def test_storage_failure_cannot_acknowledge_a_durable_transition(self):
        disk=MemoryFile();disk.fail=True
        store=state.ProtectedEnrollmentState(file=disk,context=b'owned',protector=Protector())
        with self.assertRaises(state.EnrollmentStateError) as e:
            store.commit({'version':1,'revision':0},expected_revision=None)
        self.assertEqual(e.exception.code,'state_commit_unknown')
        self.assertIsNone(disk.value)

    def test_native_store_refuses_non_windows_without_creating_any_file(self):
        import sys
        from unittest.mock import patch
        with patch.object(sys,'platform','darwin'):
            with self.assertRaises(state.EnrollmentStateError) as e:
                state.WindowsEnrollmentFile(context_digest='a'*64,windows_sid='S-1-5-21-1000')
        self.assertEqual(e.exception.code,'unsupported_platform')

    def test_invalid_clear_envelope_is_not_written_even_if_true_equals_one(self):
        disk=MemoryFile();store=state.ProtectedEnrollmentState(file=disk,context=b'owned',protector=Protector())
        for version in (True,1.0):
            with self.subTest(version=version):
                with self.assertRaises(state.EnrollmentStateError):
                    store.commit({'version':version,'revision':0},expected_revision=None)
                self.assertIsNone(disk.value)

    def test_encoded_clear_cap_is_checked_before_the_file_effect(self):
        disk=MemoryFile();store=state.ProtectedEnrollmentState(file=disk,context=b'owned',protector=Protector())
        with self.assertRaises(state.EnrollmentStateError):
            store.commit({'version':1,'revision':0,'large':'é'*state.MAX_CLEAR},expected_revision=None)
        self.assertIsNone(disk.value)

    def test_file_compare_and_replace_uses_owned_lock_and_no_arbitrary_name(self):
        from unittest.mock import patch
        import sys
        class Native:
            old=b'old';writes=[];locked=False
            def __init__(self,sid): self.sid=sid
            def __enter__(self): return self
            def __exit__(self,*args): Native.locked=False
            def lock(self,name):
                self_test.assertEqual(name,'enrollment-'+'a'*64+'.lock');Native.locked=True
            def read(self,name):
                self_test.assertTrue(Native.locked);return Native.old
            def replace(self,name,value):
                self_test.assertTrue(Native.locked);Native.writes.append((name,value))
        self_test=self
        with patch.object(sys,'platform','win32'),patch.object(state,'_WindowsFiles',Native):
            file=state.WindowsEnrollmentFile(context_digest='a'*64,windows_sid='S-1-5-21-1000')
            with self.assertRaises(state.EnrollmentStateError): file.replace(b'new',None)
            self.assertEqual(Native.writes,[])
            file.replace(b'new',b'old')
        self.assertEqual(Native.writes,[('enrollment-'+'a'*64+'.bin',b'new')])
        self.assertFalse(Native.locked)

    def test_native_handle_metadata_rejects_reparse_hardlink_or_oversize_before_read(self):
        import ctypes
        from types import SimpleNamespace
        for attrs,links,size in ((0x400,1,10),(0,2,10),(0,1,state.MAX_PROTECTED+1)):
            with self.subTest(attrs=attrs,links=links,size=size):
                native=object.__new__(state._WindowsFiles)
                native._handles=[];native._descriptor=ctypes.c_void_p()
                def info(h,out):
                    out._obj.attributes=attrs;out._obj.links=links;out._obj.size_low=size;return 1
                native.k=SimpleNamespace(CreateFileW=lambda *a:123,GetFileInformationByHandle=info)
                native._sddl=lambda *a:None
                with self.assertRaises(state.EnrollmentStateError):
                    native._open('C:\\owned\\document.bin',private=True,access=0x80000000)

    def test_exhausted_revision_never_replaces_the_last_valid_blob(self):
        import json
        disk=MemoryFile();protector=Protector()
        old={'version':1,'revision':2**53-1,'phase':'prepared'}
        disk.value=protector.protect(bytearray(json.dumps(old).encode()),context=b'owned')
        before=disk.value
        store=state.ProtectedEnrollmentState(file=disk,context=b'owned',protector=protector)
        with self.assertRaises(state.EnrollmentStateError):
            store.commit({**old,'revision':2**53},expected_revision=2**53-1)
        self.assertEqual(disk.value,before)

    def test_exact_protected_owner_acl_is_required_for_private_objects(self):
        import ctypes
        from types import SimpleNamespace
        sid='S-1-5-21-1000'
        expected='O:'+sid+'D:P(A;;FA;;;'+sid+')'
        for text in (expected,expected.replace('D:P','D:'),expected.replace('FA','FR'),
                     expected+'(A;;FA;;;WD)',expected.replace('1000','9999')):
            with self.subTest(text=text):
                native=object.__new__(state._WindowsFiles)
                native._expected=expected;native._sid=sid
                buffer=ctypes.create_unicode_buffer(text)
                def get_security(handle,kind,flags,owner,group,dacl,sacl,out): out._obj.value=1;return 0
                def to_text(sd,revision,flags,out,size): out._obj.value=ctypes.addressof(buffer);return 1
                native.a=SimpleNamespace(GetSecurityInfo=get_security,
                    ConvertSecurityDescriptorToStringSecurityDescriptorW=to_text)
                native.k=SimpleNamespace(LocalFree=lambda p:None)
                if text==expected: native._sddl(123,True)
                else:
                    with self.assertRaises(state.EnrollmentStateError): native._sddl(123,True)

    def test_fixed_local_volume_is_required_before_any_creation(self):
        from types import SimpleNamespace
        for drive_type in (0,1,2,3,4,5,6):
            with self.subTest(drive_type=drive_type):
                native=object.__new__(state._WindowsFiles)
                def volume(root,label,size,serial,component,flags,fs,fs_size): fs.value='NTFS';return 1
                native.k=SimpleNamespace(GetDriveTypeW=lambda root:drive_type,GetVolumeInformationW=volume)
                if drive_type==3: native._fixed_ntfs('C:\\')
                else:
                    with self.assertRaises(state.EnrollmentStateError): native._fixed_ntfs('Z:\\')
