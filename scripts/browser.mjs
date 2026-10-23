// Shared headless browser launcher for the test scripts: Linux uses the system Chrome on the dGPU (DRI_PRIME), Windows
// uses Edge, anything else the Chromium that ships with Playwright (or $CHROME).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

export async function launch(extraArgs = []) {
  const linuxChrome = '/usr/bin/google-chrome';
  const winEdge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const executablePath = process.env.CHROME ?? (process.platform === 'linux' && fs.existsSync(linuxChrome) ? linuxChrome : process.platform === 'win32' && fs.existsSync(winEdge) ? winEdge : undefined);
  const args = process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', ...extraArgs] : ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', ...extraArgs];
  return chromium.launch({ executablePath, headless: true, env: { ...process.env, DRI_PRIME: process.env.GPU === 'intel' ? '0' : '1' }, args });
}
