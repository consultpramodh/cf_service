export function patchCoreUtilities(source) {
  const blocks = [...source.matchAll(/  function getSheet\(keyOrName\) \{[\s\S]*?\n  \}\n/g)];
  if(blocks.length!==1)throw new Error('CORE_LOG_ROUTING_SCOPE_MISMATCH');
  const prefix = "  function getSheet(keyOrName) {\n";
  const routing = `    // CF_DURABLE_SYSTEM_LOG_ROUTING_R1
    if (keyOrName === 'SYSTEM_LOG' || keyOrName === config_().resolveSheetName('SYSTEM_LOG')) {
      var sinkId = getScriptProperties_().getProperty('CF_SERVICEOPS_SYSTEM_LOG_SINK_ID');
      if (sinkId) {
        var sinkSheet = SpreadsheetApp.openById(sinkId).getSheetByName(config_().resolveSheetName('SYSTEM_LOG'));
        if (!sinkSheet) throw new Error('SYSTEM_LOG_SINK_SHEET_MISSING');
        return sinkSheet;
      }
    }
`;
  if(!blocks[0][0].includes('CF_DURABLE_SYSTEM_LOG_ROUTING_R1'))source=source.replace(prefix,prefix+routing);
  const replaceBlocks=[...source.matchAll(/  function replaceSheetData\(keyOrName, records\) \{[\s\S]*?\n  \}\n/g)];
  if(replaceBlocks.length!==1)throw new Error('CORE_CACHE_PREFLIGHT_SCOPE_MISMATCH');
  let block=replaceBlocks[0][0];
  if(!block.includes('CF_CACHE_GRID_PREFLIGHT_R1')){
    const mapLine="    var rows = records.map(function (record) { return recordToRow(keyOrName, record); });\n";
    const growLine="    ensureGridSize(sheet, rows.length + 1, headers.length);\n";
    const anchor="    var oldRows = Math.max(0, sheet.getLastRow() - 1);\n";
    for(const token of [mapLine,growLine,anchor])if(block.split(token).length!==2)throw new Error('CORE_CACHE_PREFLIGHT_TOKEN_MISMATCH');
    block=block.replace(mapLine,'').replace(growLine,'').replace(anchor,`    // CF_CACHE_GRID_PREFLIGHT_R1: allocation failure preserves the previous data.
    var rows = (records || []).map(function (record) { return recordToRow(keyOrName, record); });
    if (rows.length) ensureGridSize(sheet, rows.length + 1, headers.length);
`+anchor);
    source=source.slice(0,replaceBlocks[0].index)+block+source.slice(replaceBlocks[0].index+replaceBlocks[0][0].length);
  }
  return source;
}
