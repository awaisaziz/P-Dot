import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const STYLES = `
@page {
  size: A4;
  margin: 18mm 16mm 20mm 16mm;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #1f2937;
  line-height: 1.6;
  font-size: 13px;
  background: #ffffff;
  margin: 0;
  padding: 0;
}
h1 {
  font-size: 24px;
  border-bottom: 2px solid #e5e7eb;
  padding-bottom: 8px;
  margin-top: 0;
  margin-bottom: 16px;
  color: #111827;
  page-break-after: avoid;
}
h2 {
  font-size: 18px;
  border-bottom: 1px solid #f3f4f6;
  padding-bottom: 6px;
  margin-top: 24px;
  margin-bottom: 12px;
  color: #1f2937;
  page-break-after: avoid;
}
h3 {
  font-size: 14px;
  margin-top: 18px;
  margin-bottom: 8px;
  color: #374151;
  page-break-after: avoid;
}
h4 {
  font-size: 12.5px;
  margin-top: 14px;
  margin-bottom: 6px;
  color: #4b5563;
  page-break-after: avoid;
}
p, ul, ol {
  margin-top: 0;
  margin-bottom: 12px;
}
li {
  margin-bottom: 4px;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
  font-size: 11px;
  page-break-inside: avoid;
}
th, td {
  border: 1px solid #e5e7eb;
  padding: 6px 9px;
  text-align: left;
}
th {
  background-color: #f9fafb;
  font-weight: 600;
  color: #111827;
}
tr:nth-child(even) {
  background-color: #fcfcfd;
}
code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
  font-size: 85%;
  background-color: #f3f4f6;
  padding: 2px 4px;
  border-radius: 4px;
  color: #991b1b;
}
pre {
  background-color: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 10px 14px;
  overflow-x: auto;
  font-size: 10.5px;
  line-height: 1.45;
  page-break-inside: avoid;
}
pre code {
  background-color: transparent;
  padding: 0;
  color: #1e293b;
  font-size: inherit;
}
blockquote {
  margin: 14px 0;
  padding: 8px 16px;
  border-left: 4px solid #3b82f6;
  background-color: #eff6ff;
  color: #1e40af;
  border-radius: 0 4px 4px 0;
  page-break-inside: avoid;
}
hr {
  border: 0;
  border-top: 1px solid #e5e7eb;
  margin: 20px 0;
}
`;

const FILES_TO_CONVERT = [
  {
    input: "docs/AI_SYSTEM_ENGINEERING_REPORT.md",
    output: "docs/pdf/AI_SYSTEM_ENGINEERING_REPORT.pdf",
    title: "P-Dot AI Layer: Comprehensive Engineering & Architecture Report",
  },
  {
    input: "docs/CROSS_TEAM_HANDOFF_AND_FUTURE_ROADMAP.md",
    output: "docs/pdf/CROSS_TEAM_HANDOFF_AND_FUTURE_ROADMAP.pdf",
    title: "P-Dot: Cross-Team Handoff Specifications & Future Roadmap",
  },
  {
    input: "docs/AI_LAYER_EXECUTIVE_SUMMARY.md",
    output: "docs/pdf/AI_LAYER_EXECUTIVE_SUMMARY.pdf",
    title: "P-Dot AI Layer: High-Level Overview & Strategic Talking Points",
  },
  {
    input: "docs/AI_EVALUATION_BENCHMARK_REPORT.md",
    output: "docs/pdf/AI_EVALUATION_BENCHMARK_REPORT.pdf",
    title: "P-Dot AI Layer: Automated Evaluation Benchmark & Hallucination Rigor Report",
  },
];

const tempDir = path.resolve(process.cwd(), "docs/pdf/.temp_html");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

console.log("Starting PDF generation for documentation reports...\n");

for (const item of FILES_TO_CONVERT) {
  const inputPath = path.resolve(process.cwd(), item.input);
  const outputPath = path.resolve(process.cwd(), item.output);
  const tempHtmlPath = path.join(tempDir, `${path.basename(item.input, ".md")}.html`);

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    continue;
  }

  console.log(`Processing: ${item.input}`);

  // 1. Convert Markdown to HTML via marked CLI
  const rawHtml = execSync(`npx -y marked -i "${inputPath}" --gfm`, { encoding: "utf-8" });

  // 2. Wrap HTML in complete document with CSS
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${item.title}</title>
  <style>${STYLES}</style>
</head>
<body>
  ${rawHtml}
</body>
</html>`;

  fs.writeFileSync(tempHtmlPath, fullHtml, "utf-8");

  // 3. Print to PDF using Headless Chrome
  console.log(`Rendering PDF: ${item.output}`);
  const chromeCmd = `"${CHROME_PATH}" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${outputPath}" "file://${tempHtmlPath}"`;
  execSync(chromeCmd, { stdio: "ignore" });

  if (fs.existsSync(outputPath)) {
    const stats = fs.statSync(outputPath);
    console.log(`✓ Generated: ${item.output} (${Math.round(stats.size / 1024)} KB)\n`);
  } else {
    console.error(`✗ Failed to generate: ${item.output}\n`);
  }
}

// Clean up temp HTML directory
fs.rmSync(tempDir, { recursive: true, force: true });
console.log("All PDFs generated successfully in docs/pdf/!");
