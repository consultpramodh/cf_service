/*******************************************************
 * APPS SCRIPT — 98_Code_Audit.gs
 *
 * ServiceOps source-code audit and consolidation.
 *
 * PUBLIC RUN FUNCTION:
 *   serviceOps_runCodeAudit()
 *
 * OUTPUT SHEETS:
 *   Code Audit
 *   Code Audit Source
 *
 * PURPOSE:
 *   Reads every source file in the current Apps Script
 *   project and consolidates it into the bound spreadsheet
 *   for review as one unit.
 *******************************************************/

const SERVICEOPS_CODE_AUDIT_ = (() => {
  'use strict';

  const CONFIG = Object.freeze({
    SUMMARY_SHEET_NAME: 'Code Audit',
    SOURCE_SHEET_NAME: 'Code Audit Source',

    APPS_SCRIPT_API_PREFIX:
      'https://script.googleapis.com/v1/projects/',

    /*
     * Google Sheets cells have finite size limits.
     * Long source lines are split safely into segments.
     */
    MAX_SOURCE_CELL_CHARACTERS: 45000,

    /*
     * Smaller batches reduce Apps Script memory pressure
     * when writing large projects.
     */
    WRITE_BATCH_SIZE: 1000,

    SUMMARY_COLUMN_COUNT: 8,
    SOURCE_COLUMN_COUNT: 6
  });

  /**
   * Main internal execution method.
   *
   * @return {Object} Audit summary.
   */
  function run() {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);

    let spreadsheet = null;
    const startedAt = getCurrentTimestamp_();

    try {
      spreadsheet = getSpreadsheet_();

      const projectContent = fetchCurrentProjectContent_();
      const audit = buildAudit_(projectContent, spreadsheet, startedAt);

      writeSummarySheet_(spreadsheet, audit);
      writeSourceSheet_(spreadsheet, audit);

      SpreadsheetApp.flush();

      spreadsheet.toast(
        `Code audit completed. ${audit.files.length} files captured.`,
        'ServiceOps Code Audit',
        8
      );

      return {
        status: 'PASS',
        generatedAt: audit.generatedAt,
        scriptId: audit.scriptId,
        fileCount: audit.files.length,
        sourceLineCount: audit.totalSourceLines,
        characterCount: audit.totalCharacters,
        projectHash: audit.projectHash
      };
    } catch (error) {
      if (spreadsheet) {
        try {
          writeFailureSheet_(spreadsheet, startedAt, error);
          SpreadsheetApp.flush();
        } catch (writeError) {
          console.error(
            'Code audit failed and the failure report could not be written.',
            writeError
          );
        }
      }

      console.error('ServiceOps code audit failed.', error);
      throw error;
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * Uses the shared ServiceOps spreadsheet helper when available.
   *
   * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
   */
  function getSpreadsheet_() {
    if (typeof serviceOps_getSpreadsheet_ === 'function') {
      const sharedSpreadsheet = serviceOps_getSpreadsheet_();

      if (sharedSpreadsheet) {
        return sharedSpreadsheet;
      }
    }

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

    if (!spreadsheet) {
      throw new Error(
        'FAILED | No active spreadsheet is available. ' +
        'This audit must run from a spreadsheet-bound Apps Script project.'
      );
    }

    return spreadsheet;
  }

  /**
   * Uses the shared ServiceOps timestamp helper when available.
   *
   * @return {Date}
   */
  function getCurrentTimestamp_() {
    if (typeof serviceOps_now_ === 'function') {
      return serviceOps_now_();
    }

    return new Date();
  }

  /**
   * Reads the current Apps Script project using the Apps Script REST API.
   *
   * @return {Object}
   */
  function fetchCurrentProjectContent_() {
    const scriptId = ScriptApp.getScriptId();

    if (!scriptId) {
      throw new Error(
        'FAILED | Apps Script did not return a script project ID.'
      );
    }

    const url =
      CONFIG.APPS_SCRIPT_API_PREFIX +
      encodeURIComponent(scriptId) +
      '/content';

    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: `Bearer ${ScriptApp.getOAuthToken()}`
      },
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    if (responseCode !== 200) {
      throw new Error(
        buildApiFailureMessage_(responseCode, responseBody)
      );
    }

    let payload;

    try {
      payload = JSON.parse(responseBody);
    } catch (error) {
      throw new Error(
        'FAILED | The Apps Script API returned invalid JSON.'
      );
    }

    if (!payload || !Array.isArray(payload.files)) {
      throw new Error(
        'FAILED | The Apps Script API response did not contain a files array.'
      );
    }

    return payload;
  }

  /**
   * Converts an API error into an actionable operator message.
   *
   * @param {number} responseCode
   * @param {string} responseBody
   * @return {string}
   */
  function buildApiFailureMessage_(responseCode, responseBody) {
    let apiMessage = String(responseBody || '').trim();

    try {
      const parsed = JSON.parse(responseBody);

      if (
        parsed &&
        parsed.error &&
        parsed.error.message
      ) {
        apiMessage = parsed.error.message;
      }
    } catch (error) {
      // Keep the raw response body.
    }

    if (responseCode === 401) {
      return [
        'SETUP_REQUIRED | Apps Script API authorization failed.',
        'Confirm that appsscript.json includes:',
        'https://www.googleapis.com/auth/script.projects.readonly',
        'https://www.googleapis.com/auth/script.external_request',
        `API response: ${apiMessage}`
      ].join('\n');
    }

    if (responseCode === 403) {
      return [
        'SETUP_REQUIRED | Apps Script API access was denied.',
        'Required setup:',
        '1. Enable the Google Apps Script API in the linked Google Cloud project.',
        '2. Enable Google Apps Script API access in the Apps Script dashboard settings.',
        '3. Run serviceOps_runCodeAudit() again and approve the permissions.',
        `API response: ${apiMessage}`
      ].join('\n');
    }

    if (responseCode === 404) {
      return [
        'FAILED | The Apps Script project could not be found.',
        'Confirm that the executing user owns or can edit the script project.',
        `API response: ${apiMessage}`
      ].join('\n');
    }

    return [
      `FAILED | Apps Script API returned HTTP ${responseCode}.`,
      `API response: ${apiMessage}`
    ].join('\n');
  }

  /**
   * Creates the normalized audit model.
   *
   * @param {Object} projectContent
   * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
   * @param {Date} generatedAt
   * @return {Object}
   */
  function buildAudit_(projectContent, spreadsheet, generatedAt) {
    const files = projectContent.files
      .map(normalizeFile_)
      .sort(compareFiles_);

    let totalSourceLines = 0;
    let totalCharacters = 0;

    files.forEach((file) => {
      totalSourceLines += file.lineCount;
      totalCharacters += file.characterCount;
    });

    const projectFingerprint = files
      .map((file) => {
        return [
          file.name,
          file.type,
          file.source
        ].join('\u0000');
      })
      .join('\u0001');

    const sourceRows = buildSourceRows_(files);

    return {
      status: 'PASS',
      generatedAt,
      spreadsheetName: spreadsheet.getName(),
      spreadsheetId: spreadsheet.getId(),
      scriptId:
        projectContent.scriptId ||
        ScriptApp.getScriptId(),
      files,
      totalSourceLines,
      totalCharacters,
      sourceOutputRows: sourceRows.length,
      projectHash: sha256_(projectFingerprint),
      sourceRows
    };
  }

  /**
   * Normalizes one Apps Script API file.
   *
   * @param {Object} file
   * @return {Object}
   */
  function normalizeFile_(file) {
    const name = String(file.name || 'Unnamed');
    const type = String(file.type || 'UNKNOWN');
    const source = String(file.source || '');

    /*
     * Normalize line endings only for sheet presentation.
     * The file hash is calculated against the original source.
     */
    const normalizedSource = source
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    const lines =
      normalizedSource === ''
        ? []
        : normalizedSource.split('\n');

    return {
      name,
      displayName: getDisplayFileName_(name, type),
      type,
      source,
      lines,
      lineCount: lines.length,
      characterCount: source.length,
      hash: sha256_(source)
    };
  }

  /**
   * Sort order:
   *   1. Manifest
   *   2. Server-side JavaScript
   *   3. HTML
   *   4. Other file types
   *
   * @param {Object} first
   * @param {Object} second
   * @return {number}
   */
  function compareFiles_(first, second) {
    const firstWeight = getFileTypeWeight_(first);
    const secondWeight = getFileTypeWeight_(second);

    if (firstWeight !== secondWeight) {
      return firstWeight - secondWeight;
    }

    return first.displayName.localeCompare(
      second.displayName,
      undefined,
      {
        numeric: true,
        sensitivity: 'base'
      }
    );
  }

  /**
   * @param {Object} file
   * @return {number}
   */
  function getFileTypeWeight_(file) {
    if (
      file.name === 'appsscript' &&
      file.type === 'JSON'
    ) {
      return 0;
    }

    if (file.type === 'SERVER_JS') {
      return 1;
    }

    if (file.type === 'HTML') {
      return 2;
    }

    if (file.type === 'JSON') {
      return 3;
    }

    return 4;
  }

  /**
   * Adds the expected editor extension.
   *
   * @param {string} name
   * @param {string} type
   * @return {string}
   */
  function getDisplayFileName_(name, type) {
    const extensionMap = {
      SERVER_JS: '.gs',
      HTML: '.html',
      JSON: '.json'
    };

    const extension = extensionMap[type] || '';

    if (
      extension &&
      name.toLowerCase().endsWith(extension)
    ) {
      return name;
    }

    return `${name}${extension}`;
  }

  /**
   * Creates the source review rows.
   *
   * Columns:
   *   File #
   *   File
   *   Type
   *   Line
   *   Segment
   *   Source
   *
   * @param {Object[]} files
   * @return {Array[]}
   */
  function buildSourceRows_(files) {
    const rows = [];

    files.forEach((file, fileIndex) => {
      const fileNumber = fileIndex + 1;

      rows.push([
        fileNumber,
        file.displayName,
        file.type,
        '',
        '',
        `===== FILE ${fileNumber}: ${file.displayName} =====`
      ]);

      if (file.lines.length === 0) {
        rows.push([
          fileNumber,
          file.displayName,
          file.type,
          0,
          1,
          ''
        ]);
      } else {
        file.lines.forEach((line, lineIndex) => {
          const segments = splitSourceLine_(line);

          segments.forEach((segment, segmentIndex) => {
            rows.push([
              fileNumber,
              file.displayName,
              file.type,
              lineIndex + 1,
              segmentIndex + 1,
              segment
            ]);
          });
        });
      }

      rows.push([
        '',
        '',
        '',
        '',
        '',
        ''
      ]);
    });

    return rows;
  }

  /**
   * Prevents source lines from exceeding a Sheets cell limit.
   *
   * @param {string} line
   * @return {string[]}
   */
  function splitSourceLine_(line) {
    const value = String(line);

    if (value.length === 0) {
      return [''];
    }

    const segments = [];

    for (
      let offset = 0;
      offset < value.length;
      offset += CONFIG.MAX_SOURCE_CELL_CHARACTERS
    ) {
      segments.push(
        value.slice(
          offset,
          offset + CONFIG.MAX_SOURCE_CELL_CHARACTERS
        )
      );
    }

    return segments;
  }

  /**
   * Writes the summary and file inventory.
   *
   * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
   * @param {Object} audit
   */
  function writeSummarySheet_(spreadsheet, audit) {
    const fileHeaderRow = 14;
    const rows = [];

    rows.push(makeRow_([
      'SERVICEOPS CODE AUDIT'
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Snapshot of every source file in the current Apps Script HEAD project.'
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Status',
      audit.status
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Generated At',
      audit.generatedAt
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Spreadsheet',
      audit.spreadsheetName
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Script Project ID',
      audit.scriptId
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Files Captured',
      audit.files.length
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Source Lines',
      audit.totalSourceLines
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Characters',
      audit.totalCharacters
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Source Output Rows',
      audit.sourceOutputRows
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Project SHA-256',
      audit.projectHash
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'File #',
      'File',
      'Type',
      'Source Lines',
      'Characters',
      'SHA-256',
      'Status',
      'Notes'
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    audit.files.forEach((file, index) => {
      rows.push(makeRow_([
        index + 1,
        file.displayName,
        file.type,
        file.lineCount,
        file.characterCount,
        file.hash,
        'CAPTURED',
        ''
      ], CONFIG.SUMMARY_COLUMN_COUNT));
    });

    rows.push(makeRow_([], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Review Location',
      CONFIG.SOURCE_SHEET_NAME,
      '',
      '',
      '',
      '',
      '',
      'Each source line is stored as literal text.'
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    rows.push(makeRow_([
      'Audit Rule',
      'Re-run after every material code change.',
      '',
      '',
      '',
      '',
      '',
      'This is a snapshot, not a live code mirror.'
    ], CONFIG.SUMMARY_COLUMN_COUNT));

    const sheet = resetSheet_(
      spreadsheet,
      CONFIG.SUMMARY_SHEET_NAME,
      Math.max(rows.length + 5, 30),
      CONFIG.SUMMARY_COLUMN_COUNT
    );

    sheet
      .getRange(1, 1, rows.length, CONFIG.SUMMARY_COLUMN_COUNT)
      .setValues(rows);

    sheet.getRange(1, 1, 1, CONFIG.SUMMARY_COLUMN_COUNT)
      .merge()
      .setFontSize(16)
      .setFontWeight('bold')
      .setBackground('#1f4e78')
      .setFontColor('#ffffff')
      .setHorizontalAlignment('left');

    sheet.getRange(2, 1, 1, CONFIG.SUMMARY_COLUMN_COUNT)
      .merge()
      .setFontStyle('italic')
      .setFontColor('#555555');

    sheet.getRange(4, 1, 9, 1)
      .setFontWeight('bold');

    sheet.getRange(5, 2)
      .setNumberFormat('yyyy-mm-dd hh:mm:ss');

    sheet.getRange(fileHeaderRow, 1, 1, CONFIG.SUMMARY_COLUMN_COUNT)
      .setFontWeight('bold')
      .setBackground('#d9eaf7');

    if (audit.files.length > 0) {
      sheet
        .getRange(
          fileHeaderRow,
          1,
          audit.files.length + 1,
          CONFIG.SUMMARY_COLUMN_COUNT
        )
        .createFilter();
    }

    sheet.setFrozenRows(fileHeaderRow);

    sheet.setColumnWidth(1, 90);
    sheet.setColumnWidth(2, 240);
    sheet.setColumnWidth(3, 120);
    sheet.setColumnWidth(4, 110);
    sheet.setColumnWidth(5, 110);
    sheet.setColumnWidth(6, 430);
    sheet.setColumnWidth(7, 110);
    sheet.setColumnWidth(8, 320);

    sheet.getDataRange()
      .setVerticalAlignment('top');

    sheet.getRange(1, 1, rows.length, CONFIG.SUMMARY_COLUMN_COUNT)
      .setWrap(true);
  }

  /**
   * Writes all source code line by line.
   *
   * Rich text is used for the source column so code beginning
   * with "=" cannot be interpreted as a spreadsheet formula.
   *
   * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
   * @param {Object} audit
   */
  function writeSourceSheet_(spreadsheet, audit) {
    const rows = audit.sourceRows;

    const sheet = resetSheet_(
      spreadsheet,
      CONFIG.SOURCE_SHEET_NAME,
      Math.max(rows.length + 10, 100),
      CONFIG.SOURCE_COLUMN_COUNT
    );

    const headers = [[
      'File #',
      'File',
      'Type',
      'Line',
      'Segment',
      'Source'
    ]];

    sheet
      .getRange(1, 1, 1, CONFIG.SOURCE_COLUMN_COUNT)
      .setValues(headers)
      .setFontWeight('bold')
      .setBackground('#1f4e78')
      .setFontColor('#ffffff');

    for (
      let offset = 0;
      offset < rows.length;
      offset += CONFIG.WRITE_BATCH_SIZE
    ) {
      const batch = rows.slice(
        offset,
        offset + CONFIG.WRITE_BATCH_SIZE
      );

      const sheetRow = offset + 2;

      const metadataValues = batch.map((row) => {
        return row.slice(0, 5);
      });

      const sourceRichTextValues = batch.map((row) => {
        return [
          SpreadsheetApp
            .newRichTextValue()
            .setText(String(row[5] ?? ''))
            .build()
        ];
      });

      sheet
        .getRange(
          sheetRow,
          1,
          batch.length,
          5
        )
        .setValues(metadataValues);

      sheet
        .getRange(
          sheetRow,
          6,
          batch.length,
          1
        )
        .setRichTextValues(sourceRichTextValues);
    }

    if (rows.length > 0) {
      sheet
        .getRange(
          1,
          1,
          rows.length + 1,
          CONFIG.SOURCE_COLUMN_COUNT
        )
        .createFilter();
    }

    sheet.setFrozenRows(1);

    sheet.setColumnWidth(1, 75);
    sheet.setColumnWidth(2, 230);
    sheet.setColumnWidth(3, 110);
    sheet.setColumnWidth(4, 75);
    sheet.setColumnWidth(5, 75);
    sheet.setColumnWidth(6, 900);

    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 5)
        .setFontFamily('Roboto')
        .setFontSize(9)
        .setVerticalAlignment('top');

      sheet.getRange(2, 6, rows.length, 1)
        .setFontFamily('Roboto Mono')
        .setFontSize(9)
        .setVerticalAlignment('top')
        .setWrapStrategy(
          SpreadsheetApp.WrapStrategy.CLIP
        );
    }

    formatSourceFileMarkers_(sheet, rows);
  }

  /**
   * Visually distinguishes file boundaries.
   *
   * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
   * @param {Array[]} rows
   */
  function formatSourceFileMarkers_(sheet, rows) {
    const markerRanges = [];

    rows.forEach((row, index) => {
      const source = String(row[5] || '');

      if (source.startsWith('===== FILE ')) {
        markerRanges.push(
          `A${index + 2}:F${index + 2}`
        );
      }
    });

    if (markerRanges.length === 0) {
      return;
    }

    sheet
      .getRangeList(markerRanges)
      .setBackground('#d9eaf7')
      .setFontWeight('bold');
  }

  /**
   * Writes a readable failure report to Code Audit.
   *
   * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
   * @param {Date} startedAt
   * @param {*} error
   */
  function writeFailureSheet_(spreadsheet, startedAt, error) {
    const message = getErrorMessage_(error);

    const status =
      message.startsWith('SETUP_REQUIRED')
        ? 'SETUP_REQUIRED'
        : 'FAILED';

    const rows = [
      makeRow_([
        'SERVICEOPS CODE AUDIT'
      ], CONFIG.SUMMARY_COLUMN_COUNT),

      makeRow_([
        'The source-code audit did not complete.'
      ], CONFIG.SUMMARY_COLUMN_COUNT),

      makeRow_([], CONFIG.SUMMARY_COLUMN_COUNT),

      makeRow_([
        'Status',
        status
      ], CONFIG.SUMMARY_COLUMN_COUNT),

      makeRow_([
        'Attempted At',
        startedAt
      ], CONFIG.SUMMARY_COLUMN_COUNT),

      makeRow_([
        'Problem',
        message
      ], CONFIG.SUMMARY_COLUMN_COUNT),

      makeRow_([
        'Required Fix',
        status === 'SETUP_REQUIRED'
          ? 'Complete the API and OAuth setup described in the problem, then rerun serviceOps_runCodeAudit().'
          : 'Correct the reported failure, then rerun serviceOps_runCodeAudit().'
      ], CONFIG.SUMMARY_COLUMN_COUNT)
    ];

    const sheet = resetSheet_(
      spreadsheet,
      CONFIG.SUMMARY_SHEET_NAME,
      20,
      CONFIG.SUMMARY_COLUMN_COUNT
    );

    sheet
      .getRange(1, 1, rows.length, CONFIG.SUMMARY_COLUMN_COUNT)
      .setValues(rows);

    sheet.getRange(1, 1, 1, CONFIG.SUMMARY_COLUMN_COUNT)
      .merge()
      .setFontSize(16)
      .setFontWeight('bold')
      .setBackground('#9c0006')
      .setFontColor('#ffffff');

    sheet.getRange(2, 1, 1, CONFIG.SUMMARY_COLUMN_COUNT)
      .merge();

    sheet.getRange(4, 1, 4, 1)
      .setFontWeight('bold');

    sheet.getRange(5, 2)
      .setNumberFormat('yyyy-mm-dd hh:mm:ss');

    sheet.setColumnWidth(1, 140);
    sheet.setColumnWidth(2, 900);

    sheet.getDataRange()
      .setWrap(true)
      .setVerticalAlignment('top');
  }

  /**
   * Creates or resets an audit-owned sheet.
   *
   * Only the two named audit sheets are modified.
   *
   * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
   * @param {string} sheetName
   * @param {number} requiredRows
   * @param {number} requiredColumns
   * @return {GoogleAppsScript.Spreadsheet.Sheet}
   */
  function resetSheet_(
    spreadsheet,
    sheetName,
    requiredRows,
    requiredColumns
  ) {
    let sheet = spreadsheet.getSheetByName(sheetName);

    if (!sheet) {
      sheet = spreadsheet.insertSheet(sheetName);
    }

    const filter = sheet.getFilter();

    if (filter) {
      filter.remove();
    }

    sheet.getBandings().forEach((banding) => {
      banding.remove();
    });

    sheet.setConditionalFormatRules([]);

    /*
     * Existing merged cells can block future writes.
     */
    sheet.getDataRange().breakApart();
    sheet.clear();

    ensureSheetSize_(
      sheet,
      requiredRows,
      requiredColumns
    );

    sheet.setHiddenGridlines(true);

    return sheet;
  }

  /**
   * Ensures enough rows and columns exist before batch writes.
   *
   * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
   * @param {number} requiredRows
   * @param {number} requiredColumns
   */
  function ensureSheetSize_(
    sheet,
    requiredRows,
    requiredColumns
  ) {
    const currentRows = sheet.getMaxRows();
    const currentColumns = sheet.getMaxColumns();

    if (currentRows < requiredRows) {
      sheet.insertRowsAfter(
        currentRows,
        requiredRows - currentRows
      );
    }

    if (currentColumns < requiredColumns) {
      sheet.insertColumnsAfter(
        currentColumns,
        requiredColumns - currentColumns
      );
    }
  }

  /**
   * Creates a fixed-width row for setValues().
   *
   * @param {Array} values
   * @param {number} width
   * @return {Array}
   */
  function makeRow_(values, width) {
    const row = new Array(width).fill('');

    values.forEach((value, index) => {
      if (index < width) {
        row[index] = value;
      }
    });

    return row;
  }

  /**
   * Creates a SHA-256 hexadecimal fingerprint.
   *
   * @param {string} value
   * @return {string}
   */
  function sha256_(value) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(value),
      Utilities.Charset.UTF_8
    );

    return bytes
      .map((byte) => {
        const unsignedByte =
          byte < 0
            ? byte + 256
            : byte;

        return unsignedByte
          .toString(16)
          .padStart(2, '0');
      })
      .join('');
  }

  /**
   * @param {*} error
   * @return {string}
   */
  function getErrorMessage_(error) {
    if (!error) {
      return 'Unknown code audit failure.';
    }

    if (error.message) {
      return String(error.message);
    }

    return String(error);
  }

  return Object.freeze({
    run
  });
})();


/**
 * PUBLIC RUN FUNCTION
 *
 * This should be the only code-audit function displayed
 * in the Apps Script Run dropdown.
 *
 * @return {Object}
 */
function serviceOps_runCodeAudit() {
  return SERVICEOPS_CODE_AUDIT_.run();
}