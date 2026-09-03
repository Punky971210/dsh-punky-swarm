# National-Standard AIP Compliance Details

> This document describes dsh-punky-swarm's compliance details for the Agent-Interconnection national standard (GB/Z 185-2026): tool 6 attributes, agent descriptor (ACS field set), message/task/session mapping, identity system, and assembly switches. The principle is "additive only, no changes to existing behavior, pluggable" — the compliance layer is a read-only projection and never changes existing storage or behavior.
> 中文: [aip-compliance.md](aip-compliance.md)

## 1. Tool 6 Attributes

Every governance tool provides the 6 attributes required by the national-standard descriptor structure:

| Attribute | Description |
|---|---|
| `toolId` | `dsh.punky-swarm.<name>` reverse-domain unique identifier |
| `name` | tool name |
| `description` | functional description |
| `version` | tool version |
| `inputParam` | JSON Schema (required always present) |
| `outputParam` | JSON Schema (required always present) |

The catalog is generated from the assembly config (when `aip.enabled=true`); generation logic in `lib/aip/tool-descriptor.js`; the version is the engine version.

## 2. Agent Descriptor (GB/Z 185.4-2026 ACS field set)

Assembly config → per-role ACS AgentCapabilitySpec descriptor (`lib/aip/agent-descriptor.js`):

- **Root object** (20 keys):
  - 14 required: `aic` / `active` / `lastModifiedTime` / `protocolVersion` / `name` / `description` / `version` / `provider` / `securitySchemes` / `endPoints` / `capabilities` / `defaultInputModes` / `defaultOutputModes` / `skills`;
  - 6 optional: `iconUrl` / `documentationUrl` / `webAppUrl` / `entityUserId` / `entityMeta` / `certificate`;
- **AgentSkill** (8 keys): 5 required: `id` / `name` / `description` / `version` / `tags`; 3 optional: `examples` / `inputModes` / `outputModes`;
- Protocol version `02.01`.

## 3. Message / Task / Session Mapping

mailbox messages, wavePlan tasks, batch status → national-standard structures (pure mapping, read-only, storage unchanged; ackId atomic write preserved). Mapping implementation in `lib/comms/aip-format.js` (`toAipMessage` / `toAipTask` / `toAipSession` projection functions, always exported, zero side effects).

## 4. Identity System (off by default)

Activated by `aip.identity.enabled=true` (default off; zero loading when off):

| Component | Description |
|---|---|
| AIC identity code | OID prefix `1.2.156.3088` + CRC-16/CCITT-FALSE + Base36 check digit |
| CAI identity certificate | national-standard agent identity certificate |
| Signing | pluggable interface, default ECDSA-P256 / RSA-2048 |
| Trust-chain verification | `verifyTrustChain` |

Implementation in `lib/aip/identity.js` (AIC validation / certificates / sign / verifyTrustChain).

**Capability boundary**: SM2 is not supported — sign is a pluggable interface, defaults ECDSA-P256 / RSA-2048; `algorithm='sm2'` is explicitly rejected.

## 5. Assembly Switches and Endpoints

| Assembly key | Default | Effect |
|---|---|---|
| `aip.enabled` | on | Generates the tool 6-attribute catalog + `GET /api/dsh-punky-swarm/tools` (filterable with `?name=`); when off, zero runtime overhead |
| `aip.identity.enabled` | off | Activates the identity system (AIC/CAI/signing/trust chain) |
| `aip.team` | jiufeng | assembly team (determines the source of the ACS role set) |

Related endpoints: `GET /api/dsh-punky-swarm/tools`, `GET /api/dsh-punky-swarm/agents`, `GET /.well-known/aip` (all read-only).

## 6. Capability Boundaries

- Tool calling (GB/Z 185.7-2026 Part 7: Agent Tool Calling) is not implemented;
- The external `/discover` server semantics (mini-ADSP) only reserve the function signature (`createMiniAdsp`), not implemented;
- ACPs communication (the other external path) is covered in [acps-communication.en.md](acps-communication.en.md).
