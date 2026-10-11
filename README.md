# Fearless Verify Bot

Requires Node.js 20+, a publicly reachable HTTPS URL, and a Discord application.

1. Run `npm install` and copy `.env.example` to `.env`.
2. In Discord Developer Portal, enable **Server Members Intent** for your bot.
3. Set OAuth2 redirect URL to `https://your-domain/callback`. Provide your bot token, client ID, client secret, guild ID, verified role ID, verification channel ID, and public HTTPS URL in `.env`.
4. Invite the bot with `bot` and `applications.commands` scopes. Grant **Kick Members**, **Manage Roles**, **View Channels**, **Send Messages**. Its role must be above the Verified role and the members it needs to kick.
5. Lock regular channels to Verified role only. Allow unverified members to view the verification channel.
6. Start with `npm start`. Use `/blockserver add id:<server_id>`, `/blockserver remove`, `/blockserver list`, and `/verifypanel`.

Verification requests OAuth2 `identify` and `guilds` consent; a normal bot cannot see a person's other servers without consent. Failed OAuth, missing consent, or service errors do not grant a role. Members who do not verify within the configured timeout are kicked. Do not publish `.env` or OAuth credentials. Use HTTPS reverse proxy (e.g. nginx) in production. This implementation checks memberships at verification time, not continuously afterward.
