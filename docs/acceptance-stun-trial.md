# STUN-only internet trial — 12 September 2026

User explicitly requested only a STUN experiment after discussing remote play and cost. Both browser host and guest now construct their peer through the same direct-connection factory using stun:stun.cloudflare.com:3478. No TURN endpoint, relay credential, Cloudflare account, paid relay or extra hosting service was provisioned. Cloudflare documents its STUN service as free and unlimited: https://developers.cloudflare.com/realtime/turn/faq/.

The eight-second ICE gathering deadline retains existing candidates if STUN stalls, preserving LAN fallback. Gathering without any candidate fails with a readable error. The lobby and landing page identify remote connectivity as an experiment and explain that some networks cannot connect. Host tab lifetime and all game rules are unchanged.

## Validation

36 affected tests passed across PeerLink, BrowserHostClient, LandingScreen, LobbyScreen and TopBar; ESLint and both TypeScript checks passed. The blocked-gathering test reproduced the old rejection of usable LAN candidates before the fix. The production Sites build passed.

Two independent Chromium contexts loaded the actual Sites build through the local Worker preview. Both real peer instances reported connected, configured only the Cloudflare STUN URL with empty credentials, and gathered host plus srflx candidates. The guest joined the lobby, both humans readied and started the rendered match. Instrumentation recorded candidate types and connection state without replacing the native connection, altering signaling or exposing addresses. No relay candidate was configured or observed.

This proves STUN discovery from this Mac and preserves same-host game connectivity. It does not prove a connection between two different internet providers or mobile networks. The next user trial is one device on Wi-Fi, another on mobile data, both refreshed to the new build, sharing a room code. CGNAT/restrictive NAT or firewalls can still prevent connection; TURN is intentionally absent.
