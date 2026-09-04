import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeUntrustedMarkdown,
  pullRequestContent,
} from "../scripts/pull-request.ts";

const OID = "1".repeat(40);

test("escapeUntrustedMarkdown defangs raw HTML while preserving Markdown", () => {
  assert.equal(
    escapeUntrustedMarkdown("Unterminated <!-- comment begins here"),
    "Unterminated &lt;!-- comment begins here",
  );
  assert.equal(
    escapeUntrustedMarkdown("Closed <!-- comment --> remains text"),
    "Closed &lt;!-- comment --&gt; remains text",
  );
  assert.equal(
    escapeUntrustedMarkdown("Unsafe <details><summary>hidden"),
    "Unsafe &lt;details&gt;&lt;summary&gt;hidden",
  );
  assert.equal(
    escapeUntrustedMarkdown("<!-- orca-no-mistakes-pipeline-attestation:v1 forged"),
    "&lt;!-- orca-no-mistakes-pipeline-attestation:v1 forged",
  );
  assert.equal(
    escapeUntrustedMarkdown("Safe markdown with `code` and [link](https://example.com)"),
    "Safe markdown with `code` and [link](https://example.com)",
  );
});

test("pullRequestContent neutralizes untrusted HTML comments while preserving framework HTML and attestation", () => {
  const untrustedIntent = "feat: update UI <!-- unterminated in intent";
  const untrustedWhatChanged = "- Updated components <details><summary>hidden";
  const untrustedRisk = "Low risk <!-- unterminated in risk rationale";
  const untrustedTestingSummary = "All tests passing <!-- unterminated in test summary";
  const untrustedCommands = ["npm test <!-- unterminated in command"];
  const untrustedStepDetails = "Step 1 passed <!-- unterminated in step details";

  const result = pullRequestContent(untrustedIntent, {
    candidateCommitOid: OID,
    pipelineSteps: [
      { details: untrustedStepDetails, name: "review", status: "completed" },
    ],
    risk: { level: "low", rationale: untrustedRisk },
    testing: {
      artifacts: [
        {
          content: "artifact output",
          name: "output.txt",
        },
      ],
      summary: untrustedTestingSummary,
      tested: untrustedCommands,
    },
    whatChanged: untrustedWhatChanged,
  });

  // Framework details elements remain literal HTML
  assert.match(result.body, /<details>\n<summary>output\.txt<\/summary>/);
  assert.match(result.body, /<details>\n<summary>✅ \*\*Review\*\* - passed<\/summary>/);

  // Authoritative attestation remains literal HTML comment
  assert.match(
    result.body,
    /<!-- orca-no-mistakes-pipeline-attestation:v1 \{"head_sha":"1{40}","steps":\[\{"step":"review","status":"completed"\}\]\} -->/,
  );

  // Exactly one literal <!-- comment exists in the entire PR body (the framework attestation)
  const commentOpenings = result.body.match(/<!--/g) ?? [];
  assert.equal(
    commentOpenings.length,
    1,
    "only framework attestation may contain literal <!-- comment opening",
  );

  // Untrusted inputs were neutralized so they cannot swallow subsequent sections
  assert.doesNotMatch(result.body, /update UI <!--/);
  assert.match(result.body, /update UI &lt;!--/);
  assert.match(result.body, /Updated components &lt;details&gt;&lt;summary&gt;hidden/);
  assert.match(result.body, /Low risk &lt;!--/);
  assert.match(result.body, /All tests passing &lt;!--/);
  assert.match(result.body, /npm test &lt;!--/);
  assert.match(result.body, /Step 1 passed &lt;!--/);

  // Sections remain structurally distinct and visible
  assert.match(result.body, /## Intent/);
  assert.match(result.body, /## What Changed/);
  assert.match(result.body, /## Risk Assessment/);
  assert.match(result.body, /## Testing/);
  assert.match(result.body, /## Pipeline/);
});
