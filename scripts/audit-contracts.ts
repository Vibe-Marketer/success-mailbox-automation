const stages = ["01_prepare", "02_approve", "03_connect", "04_verify"];
const required = ["## inputs", "## process", "## outputs", "## human check"];
const failures: string[] = [];
for (const stage of stages) {
  const path = `${stage}/CONTEXT.md`;
  if (!(await Bun.file(path).exists())) failures.push(`${path}: missing`);
  else {
    const content = (await Bun.file(path).text()).toLowerCase();
    for (const heading of required) if (!content.includes(heading)) failures.push(`${path}: missing ${heading}`);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Contract audit passed for ${stages.length} stages.`);
export {};
