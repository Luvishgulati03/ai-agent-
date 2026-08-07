import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResume, numberGuard, skillsUnchanged, renderResumeHtml } from "../src/jobs/tailor.ts";

const FIXTURE = `# JANE BUILDER

+00-1234567890 | Sample City | jane@example.com | LinkedIn

## PROFILE

Product-minded engineer who ships.

## EXPERIENCE

### Acme Corp | Sample City — Engineer (Jan 2025 - Present)

- Shipped a platform generating 516 opens and 447 clicks in 30 days.
- Automated 53 of 57 scenarios.

### Beta Ltd | Other City — Analyst (Feb 2024 - Dec 2024)

- Removed 4 hours of manual work daily.

## KEY PROJECTS

### Widget — Open Source

- Built a widget used at 2-3 institutions.

## EDUCATION

B.Tech, CS — Example University (2021 - 2025)

## SKILLS

- **Product:** PRDs, GTM, Roadmapping
- **Engineering:** TypeScript, Python
`;

test("parseResume extracts full structure from the known format", () => {
  const parsed = parseResume(FIXTURE);
  assert.equal(parsed.name, "JANE BUILDER");
  assert.match(parsed.contact, /jane@example\.com/);
  assert.equal(parsed.experience.length, 2);
  assert.deepEqual(
    parsed.experience[0],
    {
      company: "Acme Corp", location: "Sample City", title: "Engineer", dates: "Jan 2025 - Present",
      bullets: ["Shipped a platform generating 516 opens and 447 clicks in 30 days.", "Automated 53 of 57 scenarios."],
    },
  );
  assert.equal(parsed.projects.length, 1);
  assert.equal(parsed.education, "B.Tech, CS — Example University");
  assert.equal(parsed.educationDates, "2021 - 2025");
  assert.deepEqual(parsed.skills.map((s) => s.label), ["Product", "Engineering"]);
});

test("numberGuard flags metrics that do not exist in the base", () => {
  assert.deepEqual(numberGuard(FIXTURE, "Generated 516 opens and 447 clicks"), []);
  assert.deepEqual(numberGuard(FIXTURE, "Improved conversion by 38% across 12 teams"), ["38", "12"]);
  // comma-formatted numbers normalize before matching
  assert.deepEqual(numberGuard("raised 1,000 users", "grew to 1000 users"), []);
});

test("skillsUnchanged allows reorder within a row, rejects edits", () => {
  const base = [{ label: "Product", items: "PRDs, GTM, Roadmapping" }];
  assert.equal(skillsUnchanged(base, [{ label: "Product", items: "GTM, Roadmapping, PRDs" }]), true);
  assert.equal(skillsUnchanged(base, [{ label: "Product", items: "GTM, Roadmapping" }]), false);
  assert.equal(skillsUnchanged(base, [{ label: "Product", items: "GTM, Roadmapping, PRDs, Jira" }]), false);
  assert.equal(skillsUnchanged(base, [{ label: "Tools", items: "PRDs, GTM, Roadmapping" }]), false);
});

test("renderResumeHtml escapes content and keeps template structure", () => {
  const parsed = parseResume(FIXTURE);
  parsed.profile = "Ships <fast> & true.";
  const html = renderResumeHtml(parsed);
  assert.match(html, /Ships &lt;fast&gt; &amp; true\./);
  assert.match(html, /class="name">JANE BUILDER/);
  assert.match(html, /Key Projects/);
  assert.doesNotMatch(html, /<fast>/);
});
