# Copyright (c) 2026 Memlia. All rights reserved.
"""Memlia Agent executable boundary. Bootstrap secrets belong to stdin, never argv."""
from __future__ import annotations
import argparse
import asyncio
import json
import sys

class AgentEntryError(RuntimeError):
    def __init__(self,code): self.code=code;super().__init__(code)

class _Parser(argparse.ArgumentParser):
    def error(self,message):
        # argparse's default error echoes unknown arguments, which may be secrets.
        raise AgentEntryError('agent_arguments_refused')

def _output(value):
    try:
        sys.stdout.write(json.dumps(value,separators=(',',':'))+'\n')
        sys.stdout.flush()
    except Exception:
        return False  # Never render a failed/broken console's exception or frames.

def main(argv=None):
    failure=None
    try:
        parser=_Parser(prog='memlia-agent',description='Agent local Memlia — configuration transmise sur stdin.')
        parser.add_argument('operation',choices=('enroll','resume','activate','status','run'))
        options=parser.parse_args(argv)
        from .host import AgentBootstrap,HostError,perform_operation
        raw=sys.stdin.buffer.read(131073)
        bootstrap=AgentBootstrap.decode(raw,operation=options.operation)
        result=asyncio.run(perform_operation(options.operation,bootstrap,on_status=_output))
        if _output(result) is False:return 2
        return 0 if options.operation=='status' or result['phase']=='active' else 3
    except AgentEntryError as error:
        failure=error.code
    except Exception as error:
        # Only fixed host codes cross this executable boundary; no exception
        # string/frame, input, local path or native cause is ever rendered.
        from .host import HostError
        failure=error.code if type(error) is HostError else 'agent_operation_refused'
    except KeyboardInterrupt:
        failure='agent_interrupted'
    if failure:
        _output({'error':failure});return 2

if __name__=='__main__':
    raise SystemExit(main())
