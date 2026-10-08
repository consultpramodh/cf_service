export function patchReadinessCounts(source) {
  const matches = [...source.matchAll(/  function inspectReadiness\(\) \{[\s\S]*?\n  \}\n/g)];
  if (matches.length !== 1) throw new Error('READINESS_PATCH_FUNCTION_SCOPE_MISMATCH');
  const original = matches[0][0];
  let changed = original;
  for (const key of ['STRIVEN_CUSTOMER_DATA','STRIVEN_LOCATION_DATA','STRIVEN_OPERATIONAL_DATA']) {
    const before = `d.util.readRecords('${key}').length`;
    const after = `Math.max(0, d.util.requireSheet('${key}').getLastRow() - 1)`;
    const oldCount = changed.split(before).length - 1;
    const newCount = changed.split(after).length - 1;
    if (oldCount === 1 && newCount === 0) changed = changed.replace(before, after);
    else if (oldCount !== 0 || newCount !== 1) throw new Error('READINESS_PATCH_COUNT_SCOPE_MISMATCH: ' + key);
  }
  return source.slice(0,matches[0].index) + changed + source.slice(matches[0].index+original.length);
}
