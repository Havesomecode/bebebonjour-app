# Candidate provider cost and operational facts

Official public sources reviewed on 2026-08-06 for a low-volume production birth-announcement pipeline. Prices can change and may be localized.

## Tally

- Free includes unlimited forms and submissions within fair use, payment collection, file uploads, and webhooks. The primary pricing page served **Pro at €20/month** and **Business at €65/month**. Pro adds custom domains, branding removal, custom notification domains, and unlimited upload size; Business adds automatic submission-retention controls. [Pricing](https://tally.so/pricing)
- Webhooks are free. The endpoint must return `2xx` within 10 seconds; Tally documents five retries (5 minutes, 30 minutes, 1 hour, 6 hours, and 1 day). Configure and verify the `Tally-Signature` using a signing secret. [Webhooks](https://tally.so/help/webhooks)
- Tally is Belgium/EU-based and says form data is stored in Europe and encrypted in transit and at rest. The form owner is the controller and Tally is the processor. User-deleted form data is removed from backups within 90 days; automatic retention periods require Business. [GDPR](https://tally.so/help/gdpr)
- The Stripe integration adds no Tally fee beyond Stripe. Payment data appears in Tally and Stripe, but Tally says it does not store card details. Operational limitations: Stripe test cards are not supported in Tally payment forms, and recurring payments are unsupported. [Payment forms](https://tally.so/help/payment-forms)

## Stripe (France standard pricing)

- Stripe advertises no setup, monthly, or hidden fee for standard Payments pricing. Standard EEA cards cost **1.5% + €0.25** per successful charge; premium, UK, international, and currency-conversion pricing differs. [France pricing](https://stripe.com/fr/pricing)
- Publishable keys may be used client-side. Secret and restricted keys must remain server-side; prefer a restricted key where its permissions suffice. Test and live keys are separate, and webhook endpoint secrets are separate from API keys. [API keys](https://docs.stripe.com/keys)
- Verify `Stripe-Signature` using the endpoint secret and unmodified raw request body before processing an event. [Webhook signature verification](https://docs.stripe.com/webhooks/signature)

## Supabase

- Free is **$0/month** and includes 50,000 MAU, 500 MB database, 5 GB egress, 1 GB file storage, and two active projects. Free projects pause after one week of inactivity.
- Pro starts at **$25/month**; the first project is included. Published allowances include 100,000 MAU, 8 GB disk per project, 250 GB egress, 100 GB file storage, and $10/month compute credit. Additional projects start at $10/month. [Pricing](https://supabase.com/pricing)
- Paid billing combines the fixed plan fee with variable usage. Usage quotas and overages aggregate across all projects in an organization. [Billing](https://supabase.com/docs/guides/platform/billing-on-supabase)
- Production guidance calls for RLS on exposed tables, SSL enforcement, database network restrictions, and MFA. It notes Free projects can pause and their database backups are not downloadable. [Production checklist](https://supabase.com/docs/guides/platform/going-into-prod)
- Publishable keys are safe to expose but provide no user authorization by themselves; RLS remains essential. Secret keys are backend-only, grant elevated access, and bypass RLS. Supabase says legacy `anon` and `service_role` keys will be deprecated by the end of 2026 in favor of publishable and secret keys. [API keys](https://supabase.com/docs/guides/api/api-keys)

## Vercel

- Hobby is **$0/month**. Published allowances include 1 million edge requests, 100 GB fast data transfer, 4 active CPU-hours, and 360 GB-hours provisioned memory per month.
- Pro is **$20/month** with $20 included usage credit and pay-as-you-go usage after allowances and credit. [Pricing](https://vercel.com/pricing)
- Hobby is restricted to non-commercial personal use; financial-gain deployments require Pro or Enterprise. Vercel explicitly says asking for donations does not itself count as commercial usage. [Fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines)
- Runtime logs are retained for one hour on Hobby and one day on Pro. Do not log birth details, recipient addresses, tokens, or webhook bodies. [Limits](https://vercel.com/docs/limits)
- Environment values are encrypted at rest, but Vercel says they are visible to anyone with project access. Keep membership least-privileged and separate production, preview, and development secrets. Variable changes apply only to new deployments. [Environment variables](https://vercel.com/docs/environment-variables)

## Resend

- Free is **$0/month** for 3,000 emails/month, limited to 100/day, one domain, and 30-day data retention.
- Pro is **$20/month** for 50,000 emails/month, no daily cap, ten domains, 30-day retention, and overage at $0.90 per additional 1,000 emails. [Pricing](https://resend.com/pricing)
- At least one owned domain must be verified. Resend recommends using a sending subdomain to isolate reputation; a verified domain can send from any address under that domain. [Verified domains](https://resend.com/docs/dashboard/domains/introduction)
- API keys are confidential. Use separate keys to isolate applications, and restrict permission and domain where possible. A key value cannot be viewed again after creation; delete inactive keys. [API keys](https://resend.com/docs/dashboard/api-keys/introduction)
- Verify webhook signatures using the signing secret and raw body. [Webhook verification](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests)

## OpenAI text to speech

- The current generator names `gpt-4o-mini-tts`. Its official model page lists **$0.60 per 1 million input text tokens** and **$12 per 1 million output audio tokens**. It supports the speech-generation endpoint and currently has no free-tier usage. Pin the published snapshot rather than the moving alias when reproducibility matters. [GPT-4o mini TTS](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts)
- Record actual input/output usage and provider request identifiers per generation attempt. TTS is nondeterministic: generated bytes require their own digest and editorial approval even when the page and transcript inputs are unchanged.

## Low-volume production implication

- A non-pausing database plus commercial Vercel hosting gives a fixed baseline of approximately **$45/month**: Supabase Pro ($25) + Vercel Pro ($20). Tally Free and Resend Free can cover low volume; Stripe and OpenAI TTS remain usage-priced.
- A genuinely non-commercial announcement can use Vercel Hobby. Supabase Free is viable only if inactivity pausing and unavailable downloadable backups are acceptable.
- Server-only credentials: Stripe secret/restricted key, Stripe webhook secret, Supabase secret key, Resend API key, Resend webhook secret, and Tally signing secret. Store them in deployment environment variables, grant project access sparingly, and rotate on suspected exposure.
- Minimize data copied between Tally, Supabase, Resend, and logs. Avoid storing card details entirely; prefer provider-hosted payment collection.

## Pricing caveat

Tally's main pricing page served €20/month Pro and €65/month Business during this review, while its separate plans help article displayed $29/month and $89/month. This appears currency/localization-dependent; verify the exact account-region checkout price before budgeting: [plans help article](https://tally.so/help/plans-and-pricing).
