// Privacy policy and terms. Every claim here must match the code and the decision records
// (004, 005, 007, 011, 012, 013, 014, 016, 018). Data promises ship through issue #43.
import { LEGAL, MAKER } from "./site";
import type { Section } from "./types";

export const PRIVACY: Section[] = [
  {
    heading: "Who runs Supahound?",
    paragraphs: [
      `Supahound is a service of ${LEGAL.entity}, a ${LEGAL.state} limited liability company ("${MAKER.name}", "we", "us"). This policy explains what personal data Supahound collects, why, and what you can do about it. Email ${LEGAL.email} with any question.`,
    ],
  },
  {
    heading: "What is our role for each kind of data?",
    paragraphs: [
      "For your account data (your email address, workspace and billing details) we are the controller.",
      "When you connect a Supabase project, its logs can hold personal data about your own users, such as user IDs, IP addresses and email addresses. For that data you are the controller and we are your processor. We process it only to provide Supahound to you. A data processing agreement is available on request.",
    ],
  },
  {
    heading: "What data do we collect?",
    bullets: [
      "Account data: your email address, sign-in events, workspace name and team memberships. Sign-in uses one-time email links; we store no passwords.",
      "Supabase connection data: the OAuth tokens your Supabase org grants us, sealed with a key unique to your workspace. We request the analytics:read and database:read scopes only, and never ask for a service-role or secret key.",
      "Project metadata: project refs and names, and your Row Level Security policy definitions, which tell the detectors who owns which rows.",
      "Log data: Supahound reads your projects' edge logs through the Supabase Management API to run its detectors. We do not store raw log rows. We store findings and incidents: a pseudonymous actor identifier (such as a user ID), severity, counts, time ranges and structured evidence features such as enums, network ASNs and fingerprints. We never store raw user agents or query values.",
      "Query records: a list of every query Supahound runs against your project and every model call, kept as hashes and counts, never query results, so you can audit our access.",
      "Hack me scan data: the domain you scan, the DNS verification records, your acceptance of the scope agreement (who accepted and when), and the scan findings.",
      "Billing data: Stripe processes payments. Stripe holds your card details; we receive your plan and billing status and never see your card number.",
      "Website data: the public site sets no tracking or advertising cookies and runs no third-party analytics. Signed-in pages set the cookies needed to keep you signed in. Our hosting provider keeps standard request logs (IP address, time, URL) for security.",
    ],
  },
  {
    heading: "How do we use your data?",
    bullets: [
      "To run the posture scan, detectors, incident summaries and alerts you signed up for.",
      "To send service email: sign-in links, alerts and the weekly digest.",
      "To bill you and to prevent fraud and abuse of Supahound.",
      "To secure and improve Supahound. We may compute aggregate patterns across workspaces, such as how often a signal fires per hour of the week. A pattern holds only counts over Supahound's own categories. It never holds a table, column, project, actor, IP address or query value, and we publish one only when at least 10 workspaces contribute.",
    ],
    paragraphs: ["We do not sell personal data, and we do not share it for advertising."],
  },
  {
    heading: "Does Supahound send my data to AI models?",
    paragraphs: [
      "Supahound uses a language model to write the plain-English summary of an incident. The model receives only that incident's structured features, such as counts, categories and the label \"actor A\". It never receives user IDs, emails, IP addresses, user agents, query values, raw log text or your workspace name.",
      "Every model call goes through Vercel AI Gateway with zero data retention required and prompt training disallowed. The gateway sends the call only to a provider with a zero-data-retention agreement and fails the call if none is available. The primary model is Anthropic's Claude Haiku; the fallback is xAI's Grok. If both fail, Supahound sends template text instead. We never use your data to train models.",
    ],
  },
  {
    heading: "Who processes data for us?",
    paragraphs: ["We use these subprocessors. We will update this list before we add a new one."],
    bullets: [
      "Cloudflare, Inc. (United States): hosting, background jobs, database connections and email delivery.",
      "Supabase, Inc. (United States): Supahound's own database and sign-in.",
      "Stripe, Inc. (United States): payments and billing.",
      "Vercel, Inc. (United States): AI Gateway, which routes model calls under zero data retention.",
      "Anthropic, PBC (United States): incident summaries, under zero data retention.",
      "X.AI Corp. (United States): fallback incident summaries, under zero data retention.",
    ],
  },
  {
    heading: "How do we protect your data?",
    bullets: [
      "Each workspace's data is isolated in the database by forced Row Level Security, and every database session is scoped to one workspace.",
      "OAuth tokens are encrypted with a key derived per workspace and bound to that workspace and connection.",
      "Supahound's access to your Supabase org is read-only.",
      "All traffic is encrypted in transit with TLS.",
    ],
  },
  {
    heading: "How long do we keep data?",
    bullets: [
      "Incidents and findings: for the incident history of your plan (30 days on paid plans), then deleted.",
      "Account data: while your account is open, and deleted within 30 days after you close it, except records we must keep for tax or legal reasons.",
      "OAuth tokens: until you disconnect the Supabase org or close your account. You can also revoke our access at any time from your Supabase dashboard.",
      "Scope agreements for hack me scans: kept as an append-only legal record for as long as the law requires us to show that a scan was authorized.",
    ],
  },
  {
    heading: "What are my rights?",
    paragraphs: [
      `Depending on where you live (for example under the GDPR, UK GDPR or California law), you may have the right to access, correct, delete or export your personal data, to object to or restrict processing, and to complain to a data protection authority. Email ${LEGAL.email} and we will answer within 30 days. If you are an end user of an app that uses Supahound, contact that app's owner first; we will help them answer you.`,
    ],
  },
  {
    heading: "Where is data processed?",
    paragraphs: [
      "We are based in the United States, and our subprocessors may process data in the United States and other countries. Where the law requires it, we use standard contractual clauses for international transfers.",
    ],
  },
  {
    heading: "Children",
    paragraphs: ["Supahound is a tool for businesses and developers. It is not meant for anyone under 16, and we do not knowingly collect their data."],
  },
  {
    heading: "Changes to this policy",
    paragraphs: ["We will post any change here and update the effective date. For a material change, we will email account owners before it takes effect."],
  },
];

export const TERMS: Section[] = [
  {
    heading: "1. Agreement",
    paragraphs: [
      `These terms are an agreement between you and ${LEGAL.entity} ("${MAKER.name}", "we", "us") for the use of Supahound and its website. If you use Supahound for a company, you agree for that company and confirm that you may bind it. If you do not agree, do not use Supahound.`,
    ],
  },
  {
    heading: "2. The service",
    paragraphs: [
      "Supahound monitors Supabase projects you connect. It runs posture scans, reads project logs to detect abnormal traffic, groups findings into incidents, writes summaries and sends alerts. The hack me scan checks a web domain you have verified. We may change features over time; we will not remove a core paid feature during a billing period you have paid for.",
    ],
  },
  {
    heading: "3. Your account",
    paragraphs: [
      "Keep your email account secure, because sign-in links go to it. You are responsible for activity in your workspace and for the people you invite to it. Tell us at once if you think someone has accessed your account without permission.",
    ],
  },
  {
    heading: "4. Your projects and your users' data",
    paragraphs: [
      "You confirm that you have the right to connect each Supabase org and project, and a lawful basis to let us process the personal data in its logs for you. You own your data. You give us the rights we need to process it to provide Supahound, as described in our Privacy Policy. You may disconnect a project or revoke our access at any time.",
    ],
  },
  {
    heading: "5. Hack me scans",
    bullets: [
      "Scan only domains you own or have written permission to test. You must prove control of the domain with the DNS record we issue before any scan runs.",
      "The scan stays inside the verified domain. We refuse government, military and major platform domains, even with a valid record, and we may refuse any scan at our discretion.",
      "You must not try to get around domain verification or scope limits, or use Supahound to scan anyone else.",
      "You accept the scope agreement shown before each scan. We keep a record of that acceptance.",
      "The scan sends normal web requests to your domain. You are responsible for telling your hosting provider or anyone else who needs to know.",
    ],
  },
  {
    heading: "6. Acceptable use",
    bullets: [
      "Do not use Supahound to break the law or to harm, probe or attack systems you do not own.",
      "Do not try to access other workspaces' data, or to test Supahound's own security without our written permission. Report vulnerabilities to us instead.",
      "Do not reverse engineer, resell or overload Supahound, except that Agency customers may share client reports with their clients.",
    ],
  },
  {
    heading: "7. Plans and billing",
    paragraphs: [
      "The Free plan costs nothing. Paid plans are billed monthly in advance per connected project, through Stripe, and renew automatically until cancelled. The Agency plan has a 10-project minimum. Prices are listed on the pricing page and exclude taxes.",
      "You can cancel at any time. Cancellation takes effect at the end of the current billing period, and we do not refund partial periods unless the law requires it. We will give you at least 30 days' notice of a price increase. If a payment fails, we may move your projects to the Free plan.",
    ],
  },
  {
    heading: "8. What Supahound does not promise",
    paragraphs: [
      "Supahound detects suspicious activity; it does not block it. No monitoring tool finds every attack, and Supahound will miss some and may flag activity that is harmless. Supahound does not replace securing your app, your RLS policies or your keys.",
      "Incident summaries and suggested fixes are generated partly by software, including AI models, and can be wrong. Review every suggested fix, especially SQL, before you apply it.",
    ],
  },
  {
    heading: "9. Third-party services",
    paragraphs: [
      "Supahound depends on services we do not control, including Supabase's Management API and log retention. Their outages or changes can affect Supahound. Your use of those services is governed by their own terms.",
    ],
  },
  {
    heading: "10. Intellectual property and feedback",
    paragraphs: [
      "We own Supahound, its software and its content. These terms give you the right to use Supahound while your account is in good standing. If you send us feedback, we may use it without any obligation to you.",
    ],
  },
  {
    heading: "11. Disclaimers",
    paragraphs: [
      "Except as these terms state, Supahound is provided \"as is\" and \"as available\", without warranties of any kind, including merchantability, fitness for a particular purpose and non-infringement, to the extent the law allows.",
    ],
  },
  {
    heading: "12. Limitation of liability",
    paragraphs: [
      "To the extent the law allows, neither party is liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue or data, even if told they were possible. Our total liability for any claim about Supahound is limited to the amount you paid us in the 12 months before the claim, or US$100 if you paid nothing.",
    ],
  },
  {
    heading: "13. Indemnity",
    paragraphs: [
      "You will defend and indemnify us against third-party claims that arise from your data, your breach of these terms, or a scan of a domain you were not authorized to test.",
    ],
  },
  {
    heading: "14. Ending the agreement",
    paragraphs: [
      "You can close your account at any time. We may suspend or close an account that breaks these terms, puts others at risk, or goes unpaid, and we will tell you why unless the law or safety prevents it. Sections 8 to 15 survive the end of this agreement.",
    ],
  },
  {
    heading: "15. Law and disputes",
    paragraphs: [
      `The laws of the State of ${LEGAL.state}, USA, govern these terms, without regard to conflict-of-law rules. The state and federal courts in ${LEGAL.state} have exclusive jurisdiction, and both parties consent to them.`,
    ],
  },
  {
    heading: "16. Changes and contact",
    paragraphs: [
      `We may update these terms. We will post the change here and, for a material change, email account owners at least 14 days before it takes effect. Continued use after that means you accept the new terms. Questions go to ${LEGAL.email}.`,
    ],
  },
];
