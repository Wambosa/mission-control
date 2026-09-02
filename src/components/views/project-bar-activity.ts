export type PinnedProjectLogoActivity = {
  cliRunningCount: number;
};

export function shouldFlashPinnedProjectLogo({
  cliRunningCount,
}: PinnedProjectLogoActivity): boolean {
  return cliRunningCount > 0;
}
