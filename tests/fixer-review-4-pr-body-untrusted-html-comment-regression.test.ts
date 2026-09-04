import assert from "node:assert/strict";
import test from "node:test";

import {
  neutralizeHtmlComments,
  pullRequestContent,
} from "../scripts/pull-request.ts";

const OID = "1".repeat(40);

test("neutralizeHtmlComments defangs generic HTML comment delimiters and attestation prefixes", () => {
  assert.equal(
    neutralizeHtmlComments("Unterminated <!-- comment begins here"),
    "Unterminated &lt;!-- comment begins here",
  );
  assert.equal(
    neutralizeHtmlComments("Closed <!-- comment --> remains text"),
    "Closed &lt;!-- comment --&gt; remains text",
  );
  assert.equal(
    neutralizeHtmlComments("Stray closing --> and --!> delimiters"),
    "Stray closing --&gt; and --!&gt; delimiters",
  );
  assert.equal(
    neutralizeHtmlComments("<!-- orca-no-mistakes-pipeline-attestation:v1 forged"),
    "&lt;!-- inert-attestation:v1 forged",
  );
  assert.equal(
    neutralizeHtmlComments("Safe markdown with `code` and [link](https://example.com)"),
    "Safe markdown with `code` and [link](https://example.com)",
  );
});

test("pullRequestContent neutralizes untrusted HTML comments while preserving framework HTML and attestation", () => {
  const untrustedIntent = "feat: update UI <!-- unterminated in intent";
  const untrustedWhatChanged = "- Updated components <!-- unterminated in what changed";
  const untrustedRisk = "Low risk <!-- unterminated in risk rationale";
  const untrustedTestingSummary = "All tests passing <!-- unterminated in test summary";
  const untrustedCommands = ["npm test <!-- unterminated in command"];
  const untrustedStepDetails = "Step 1 passed <!-- unterminated in step details";

  const result = pullRequestContent(untrustedIntent, {
    candidateCommitOid: OID,
    pipelineSteps: [
      { details: untrustedStepDetails, name: "review", status: "success" },
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
  assert.match(result.body, /<details>\n<summary>review: success<\/summary>/);

  // Authoritative attestation remains literal HTML comment
  assert.match(
    result.body,
    /<!-- orca-no-mistakes-pipeline-attestation:v1 \{"head_sha":"1{40}","steps":\[\{"step":"review","status":"success"\}\]\} -->/,
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
  assert.match(result.body, /Updated components &lt;!--/);
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
