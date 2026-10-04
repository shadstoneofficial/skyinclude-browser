# Resolver provider status and qualification

Updated 2026-10-04. This record distinguishes browser integration from a
provider's availability and DNSSEC-validation capabilities. It is not an uptime
guarantee or confirmation of a provider's private production configuration.

## Active integrations

| Order | Provider | Endpoint | Qualification boundary |
| --- | --- | --- | --- |
| 1 | HNS DoH | `https://hnsdoh.com/dns-query` | Supports authenticated TLSA on a tested node; default routing has shown HNS-query failures |
| 2 | Web3DNS DoH | `https://doh.web3dns.net/` | Root-path binary DoH answers A and TLSA; the observed TLSA answer lacked DNSSEC authentication |

The Web3DNS DNS JSON adapter at `https://api.web3dns.net/` remains supported for
custom/legacy configurations. It is not an independent operator or an extra
redundancy layer beside Web3DNS binary DoH. The hostname must be retained to
preserve the operator's routing; do not hard-code an observed node IP.

## Archived provider

Shakestation DoH (`https://resolve.shakestation.io/dns-query`) was retired from
SkyInclude's active resolver list on 2026-10-04 at the project owner's direction
that the service will not return. Historical references are retained for audit
purposes, not as recommended endpoints. New lookups must not contact this host.
Migration removes the exact retired hostname without treating similarly named
custom providers as the retired service, and tells affected users what changed.

## Web3DNS evidence and open questions

At 03:59 UTC on 2026-10-04, two bounded read-only binary DoH GET requests to the
root endpoint used normal HTTPS certificate verification, RD+AD flags, EDNS DO,
and CD clear:

- `handshake.mercenary A`: NOERROR, `168.144.102.205`, AD=false.
- `_443._tcp.handshake.mercenary TLSA`: NOERROR, the expected `3 1 1` value,
  AD=false. Its SPKI SHA-256 was
  `530d46ec4e4ee9a13aa937fa0667b59c175402c0b24399ac8ed2959687c04d23`.

These results prove query/record compatibility at that moment, not authenticated
TLSA validation. SkyInclude rejects unauthenticated TLSA for certificate trust
and continues to the next configured provider, if any. It never manufactures
an AD flag, disables DANE checks, or silently falls back to raw manifest JSON.

The operator's published [reference configuration](https://github.com/james-stevens/handshake-volume-resolver/blob/7f10baaf875a5b796b1bba423568a0c2880c1cc6/etc/named.conf#L24)
sets `dnssec-validation no` globally, inherited by its recursive view. Its
non-recursive root view has a separate setting. This is consistent with the
observed recursive answer but is not proof that the public deployment uses that
exact configuration. Operator confirmation remains outstanding.

### Operator inquiry draft — not sent

SkyInclude is integrating your binary DoH endpoint at
`https://doh.web3dns.net/` while preserving hostname-based failover. Could you
confirm that `/` is the stable public contract for GET and POST, and whether
recursive HNS answers are DNSSEC-validated?

On 2026-10-04 at 03:59 UTC, with RD+AD and EDNS DO set and CD clear, both A and
TLSA queries for `handshake.mercenary` returned NOERROR with AD=false. TLSA
matched the site's expected key, but our browser cannot use unauthenticated
records to authorize native HTTPS. Is this expected behavior, and is there an
existing supported validating endpoint or a plan to provide validated answers?
We need valid chains to authenticate, broken chains to fail, and authenticated
negative answers to remain distinguishable from lookup failures. Please also
confirm supported rate limits and the privacy/status contact for browser use.

## Remaining acceptance gates

1. Obtain the operator's endpoint/validation contract; do not label this draft
   inquiry as sent or answered until it actually is.
2. Qualify successful, negative and broken-DNSSEC answers over authenticated
   transport. A correct-looking record is not a substitute for validation.
3. Exercise forced failover and recovery using isolated browser profiles.
4. Confirm cold live native HTTPS navigation and truthful website/TLSA provider
   details before claiming the end-to-end issue is resolved.
5. Keep source review, signed-package acceptance, release and installation
   approvals separate. This work does not deploy or expose a new resolver.
