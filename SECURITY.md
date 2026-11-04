# Security and Privacy

Do not post credentials, private QQ/group identifiers, conversation transcripts,
local configuration, or runtime state in public issues or pull requests.

The console is a local administrative interface. Do not expose it directly to
the Internet, put its token in a public URL, or share an authenticated browser
session. Keep OneBot management endpoints local and authenticated.

Model prompts include authorized messages, role cards, and conversation context.
Online search and optional speech introduce additional third-party requests.
Review each provider's data handling and obtain participant consent before use.

Allowlists and tool boundaries are important controls, not a guarantee against
prompt injection, mistaken replies, provider failures, or QQ account restrictions.
Regex-based outbound secret checks cannot recognize every secret. Filesystem ACLs
are not encryption. Keep independent backups of your private installation.

For a suspected vulnerability, use a private contact channel agreed with the
repository owner. If no private reporting channel exists, publish only a minimal
description and request a private channel without including exploit credentials
or another person's messages.

For incidents: stop the bridge, revoke affected tokens/keys at their issuers,
review local logs privately, and remove public copies where possible. Deleting a
Git commit does not erase already published secrets or copies held by others.
