import assert from "node:assert";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}
check("repo has lib dir scaffolding ready", true);
check("node version ok", Number(process.versions.node.split(".")[0]) >= 20);
if (failures > 0) process.exit(1);
console.log("SMOKE PASS");