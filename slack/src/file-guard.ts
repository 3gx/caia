import {
  processSlackFiles,
  type ProcessSlackFilesOptions,
  type ProcessedFile,
  type SlackFile,
} from './file-handler.js';

export interface FileGuardOptions {
  allowInlineFallback?: boolean;
}

export interface GuardableProcessResult<TFile extends { error?: string } = ProcessedFile> {
  files: TFile[];
  warnings: string[];
}

export interface FileGuardResult<TFile extends { error?: string } = ProcessedFile> extends GuardableProcessResult<TFile> {
  hasFailedFiles: boolean;
  failureWarnings: string[];
  failedFiles: TFile[];
  failureMessage?: string;
}

function isInlineWarning(warning: string): boolean {
  return warning.toLowerCase().includes('inline data url');
}

function isSkipWarning(warning: string): boolean {
  return warning.toLowerCase().includes('skipped -');
}

function isDownloadWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return lower.includes('download timed out') || lower.includes('could not be downloaded');
}

function isTooLargeWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return lower.includes('too large') && !lower.includes('inline data url');
}

function collectFailureWarnings(warnings: string[], allowInlineFallback: boolean): string[] {
  return warnings.filter((warning) => {
    if (isSkipWarning(warning) || isDownloadWarning(warning) || isTooLargeWarning(warning)) {
      return true;
    }
    if (!allowInlineFallback && isInlineWarning(warning)) {
      return true;
    }
    return false;
  });
}

function buildFailureMessage(failureWarnings: string[]): string {
  const lines = [
    'Some attached files could not be processed and were not sent to the model.',
  ];
  for (const warning of failureWarnings) {
    lines.push(`- ${warning}`);
  }
  lines.push('Please re-upload the file(s) and try again.');
  return lines.join('\n');
}

export function evaluateFileProcessing<TFile extends { error?: string }>(
  result: GuardableProcessResult<TFile>,
  guardOptions: FileGuardOptions = {}
): FileGuardResult<TFile> {
  const allowInlineFallback = guardOptions.allowInlineFallback ?? true;
  const failedFiles = result.files.filter((file) => Boolean(file.error));
  const failureWarnings = collectFailureWarnings(result.warnings, allowInlineFallback);
  const hasFailedFiles = failedFiles.length > 0 || failureWarnings.length > 0;
  const failureMessage = hasFailedFiles ? buildFailureMessage(failureWarnings) : undefined;

  return {
    ...result,
    hasFailedFiles,
    failureWarnings,
    failedFiles,
    failureMessage,
  };
}

export async function processSlackFilesWithGuard(
  files: SlackFile[],
  token: string,
  options: ProcessSlackFilesOptions = {},
  guardOptions: FileGuardOptions = {}
): Promise<FileGuardResult<ProcessedFile>> {
  const result = await processSlackFiles(files, token, options);
  return evaluateFileProcessing(result, guardOptions);
}
