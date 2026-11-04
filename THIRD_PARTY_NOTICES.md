# Third-Party Notices

The project's MIT license covers project-owned code only. Original copyright
notices remain in `LICENSE`. No license is granted here for QQ, SnowLuma, provider
services, trademarks, or third-party character/media assets.

This source package contains no installed `node_modules`, Python vendor runtime,
QQ client, SnowLuma executable/source tree, or proprietary native components.
Users acquire and configure their own gateway separately. The console includes
an operator-controlled launcher for an already-installed SnowLuma; it is not an
installer and does not automatically accept upstream terms.

## Locked direct npm dependencies

The following declarations come from the included `package-lock.json` and the
installed package metadata inspected while preparing this release. They are
metadata, not an interpretation of legal compatibility or permission to use.

| Package | Locked version | Declared license |
| --- | --- | --- |
| `@deepseek-ai/dsh-host-apiproxy` | 0.1.1-rc.2 | MIT |
| `@deepseek-ai/schemastery` | 3.18.1 | MIT |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `@snowluma/mcp` | 1.14.20 | SEE LICENSE IN LICENSE |
| `@snowluma/sdk` | 1.14.20 | SEE LICENSE IN LICENSE |
| `js-yaml` | 4.3.2 | MIT |
| `zod` | 4.4.3 | MIT |

Read each package's actual license and upstream terms before redistribution or
use. In particular, a `SEE LICENSE IN LICENSE` declaration is not an MIT grant;
if the referenced license is missing or unclear, obtain it from the maintainer.
Do not assume the gateway or its npm packages permit commercial deployment.

The existing `postinstall` script patches local installed copies of the two
SnowLuma npm packages. Inspect `scripts/patch-snowluma-sdk.mjs` and confirm the
applicable terms before installation or redistributing modified dependencies.
Those dependency copies are not included in this repository or source archive.

## Optional speech

`scripts/requirements-voice.txt` requests `edge-tts==7.3.1`. It and its transitive
dependencies are installed by the user, not vendored in this source package.
Their licenses and Microsoft service terms remain applicable. Text is transmitted
to the online speech service only after explicit local operator consent.

FFmpeg is optional, separately installed software with build-specific licensing.
No FFmpeg executable is bundled. Review the license for your actual build.
