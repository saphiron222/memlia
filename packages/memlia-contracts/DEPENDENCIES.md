# Dependencies and provenance

All new Memlia files are provisionally all rights reserved. This is not a license
grant for those files. No upstream authentication implementation or EE source is
copied. Sim API shapes and job names were examined at commit
c6cef5f87b6a1d1d01df89e7140bad9e9fd4c2e2 (Apache-2.0 portions only).

| Dependency | Version used | License | Reason |
| --- | --- | --- | --- |
| Zod | 4.3.6 | MIT | Existing Sim runtime validator; authoritative contract and native JSON Schema export |
| jsonschema | 4.26.0 | MIT | Standards-based Python validation, no handwritten schema duplication |
| attrs | 26.1.0 | MIT | jsonschema dependency |
| jsonschema-specifications | 2025.9.1 | MIT | jsonschema metaschemas |
| referencing | 0.37.0 | MIT | jsonschema dependency; network references forbidden by loader |
| rpds-py | 2026.9.1 | MIT | referencing dependency; platform wheel inventory remains a release obligation |
| typing-extensions | 4.16.0 | PSF-2.0 | Python 3.12 referencing dependency |
| setuptools | 80.9.0 | MIT | Isolated Python wheel build |
| wheel | 0.45.1 | MIT | Isolated build environment only |
| @typescript/typescript6 | package 6.0.2; compiler reports 6.0.3 | Apache-2.0 | Existing Sim compiler; development only |
| @types/node | 24.2.1 declared (upstream); 22.18.12 initial isolation | MIT | Node built-in types; development only |

Bun 1.4.2 is provisioned by the integrator and used directly. Initial exploration
used Node 22.22.3 with tsx 4.20.6 (MIT) and TypeScript 5.9.3 (Apache-2.0); these are
not dependencies of the delivered package. No root lockfile was created or
modified. Integration must lock the declared existing JS dependency versions and
Python transitive artifacts in its owned environment before release. Installed
Python package metadata was inspected for versions/licenses; this inventory does
not replace the release SBOM or a native binary audit.

The canonical Zod export behavior was checked against the official documentation:
https://zod.dev/json-schema . JSON Schema draft 2020-12 is the interchange format;
unsupported Zod constructs must throw during export.
