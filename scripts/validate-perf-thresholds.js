/**
 * Performance Threshold Validator
 *
 * Parses k6 JSON output and validates against performance budgets.
 * Fails CI if any threshold is exceeded.
 *
 * Usage:
 *   node scripts/validate-perf-thresholds.js perf-results.json
 *
 * Budgets:
 * - Intent Inference P95 < 800ms
 * - Step Execution P95 < 2000ms
 * - Chat Response P95 < 1500ms
 * - Error Rate < 1%
 */

const fs = require("fs");
const path = require("path");

// Performance budgets (in milliseconds)
const BUDGETS = {
  intent_inference_latency: { p95: 800, label: "Intent Inference" },
  step_execution_latency: { p95: 2000, label: "Step Execution" },
  chat_response_latency: { p95: 1500, label: "Chat Response" },
  http_req_duration: { p95: 800, label: "HTTP Request Duration" },
};

// Error rate threshold (percentage)
const ERROR_RATE_THRESHOLD = 0.01; // 1%

function validateThresholds(filePath) {
  console.log(`🔍 Validating performance thresholds from: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  let data;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    // k6 JSON output is one JSON object per line (NDJSON format)
    // We need to parse all lines and aggregate
    const lines = content
      .trim()
      .split("\n")
      .filter((line) => line.trim());

    if (lines.length === 0) {
      console.error("❌ Empty results file");
      process.exit(1);
    }

    // Parse all lines and merge metrics
    const allMetrics = {};
    for (const line of lines) {
      try {
        const jsonData = JSON.parse(line);
        if (jsonData.metrics) {
          for (const [key, value] of Object.entries(jsonData.metrics)) {
            if (!allMetrics[key]) {
              allMetrics[key] = value;
            } else if (value.values) {
              // Merge values (take the latest as it's the final summary)
              allMetrics[key] = value;
            }
          }
        }
      } catch (parseError) {
        console.warn(
          `⚠️  Warning: Failed to parse line: ${parseError.message}`,
        );
      }
    }

    data = { metrics: allMetrics };
  } catch (error) {
    console.error(`❌ Failed to parse JSON: ${error.message}`);
    process.exit(1);
  }

  if (!data.metrics) {
    console.error("❌ No metrics found in results file");
    process.exit(1);
  }

  let hasFailures = false;
  const results = [];

  // Validate each metric against budgets
  for (const [metricName, budget] of Object.entries(BUDGETS)) {
    const metric = data.metrics[metricName];

    if (!metric || !metric.values) {
      console.warn(`⚠️  Metric not found: ${metricName}`);
      continue;
    }

    const p95 = metric.values["p(95)"] || metric.values["p95"];

    if (p95 === undefined) {
      console.warn(`⚠️  P95 value not found for: ${metricName}`);
      continue;
    }

    const passed = p95 <= budget.p95;
    const status = passed ? "✅ PASS" : "❌ FAIL";

    results.push({
      label: budget.label,
      metric: metricName,
      p95: p95.toFixed(2),
      budget: budget.p95,
      status,
    });

    if (!passed) {
      hasFailures = true;
      console.error(
        `${status}: ${budget.label} P95 latency ${p95.toFixed(2)}ms exceeds ${budget.p95}ms budget`,
      );
    } else {
      console.log(
        `${status}: ${budget.label} P95 latency ${p95.toFixed(2)}ms <= ${budget.p95}ms budget`,
      );
    }
  }

  // Check error rate
  const errorRateMetric = data.metrics["error_rate"] || data.metrics["checks"];
  if (errorRateMetric && errorRateMetric.values) {
    const errorRate =
      errorRateMetric.values.rate || errorRateMetric.values["p(95)"];
    if (errorRate !== undefined) {
      const errorRatePercent = (errorRate * 100).toFixed(2);
      const passed = errorRate <= ERROR_RATE_THRESHOLD;
      const status = passed ? "✅ PASS" : "❌ FAIL";

      results.push({
        label: "Error Rate",
        metric: "error_rate",
        value: `${errorRatePercent}%`,
        budget: `${(ERROR_RATE_THRESHOLD * 100).toFixed(2)}%`,
        status,
      });

      if (!passed) {
        hasFailures = true;
        console.error(
          `${status}: Error rate ${errorRatePercent}% exceeds ${(ERROR_RATE_THRESHOLD * 100).toFixed(2)}% budget`,
        );
      } else {
        console.log(
          `${status}: Error rate ${errorRatePercent}% <= ${(ERROR_RATE_THRESHOLD * 100).toFixed(2)}% budget`,
        );
      }
    }
  }

  // Print summary table
  console.log("\n📊 Performance Budget Summary:");
  console.log("─".repeat(80));
  console.log(
    `${"Metric".padEnd(25)} | ${"P95/Value".padEnd(15)} | ${"Budget".padEnd(15)} | Status`,
  );
  console.log("─".repeat(80));

  for (const result of results) {
    const value = result.p95 ? `${result.p95}ms` : result.value;
    console.log(
      `${result.label.padEnd(25)} | ${value.padEnd(15)} | ${result.budget.toFixed ? result.budget.toFixed(2) + "ms" : result.budget.padEnd(15)} | ${result.status}`,
    );
  }

  console.log("─".repeat(80));

  if (hasFailures) {
    console.error("\n❌ FAIL: Performance budgets exceeded");
    console.error("Review the metrics above and optimize the slow endpoints.");
    process.exit(1);
  } else {
    console.log("\n✅ PASS: All performance budgets met");
    process.exit(0);
  }
}

// Main execution
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error(
    "Usage: node scripts/validate-perf-thresholds.js <results-file.json>",
  );
  console.error(
    "Example: node scripts/validate-perf-thresholds.js k6-results.json",
  );
  process.exit(1);
}

const filePath = path.resolve(args[0]);
validateThresholds(filePath);
