# Signgate

Signgate gets a company's standard client agreement signed on every file, automatically.

Upload the agreement once, in whatever form it exists today. From then on, opening a file
(one job or case for one client) sends the agreement for signature, follows up until it is
signed, collects the company's countersignature, and stores a sealed PDF with an audit
certificate. Work starts when the file shows as signed.

## Run it locally

```bash
npm install
npm run dev
```

No database or accounts are needed locally: without `DATABASE_URL` the app runs on an embedded
Postgres stored in `.data/`. See `.env.example` for the optional settings.

```bash
npm run typecheck
npm test
```
