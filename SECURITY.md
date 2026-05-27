# Security Policy

## Supported Versions

This project is early-stage. Please use the latest commit on the default branch when testing security fixes.

## Reporting a Vulnerability

Please do not open a public issue for a sensitive vulnerability.

Email the maintainers or use GitHub private vulnerability reporting if it is enabled on the repository. Include:

- A concise description of the issue
- Steps to reproduce
- Affected platform and app version
- Any relevant logs with personal data removed

## Security Notes

SkyInclude Browser is an Electron application that loads arbitrary web content. The app keeps Node integration disabled for web content and uses a preload bridge for IPC.

HNS HTTP traffic is routed through a local proxy. The proxy is bound to `127.0.0.1` and is used to preserve native HNS hostnames while forwarding requests to resolved addresses.

