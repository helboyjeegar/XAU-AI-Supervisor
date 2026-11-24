# Cloudflare Workers deployment

The `develop` branch is connected to the Cloudflare Worker `xau-ai-supervisor`.

Expected Cloudflare Builds configuration:

- Production branch: `develop`
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

The Worker is analysis-and-alerts-only. It does not execute broker orders. Required runtime bindings and secrets must be configured in Cloudflare before live ingestion or Telegram features are enabled.
