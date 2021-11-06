#!/bin/env node

/*
 * This script is to update the "latest" tag on npm to the latest beta release
 * as we currently only offer beta builds.
 */

const fs = require("fs");
const child_process = require("child_process");

const packageJSON = JSON.parse(fs.readFileSync("package.json", "utf8"));

function npmDistTag(packageName, version, tagName) {
  try {
    return child_process.execSync(`npm dist-tag add ${packageName}@${version} ${tagName}`).toString("utf8").trim();
  } catch (e) {
    throw e;
  }
}

const packageName = packageJSON.name;
const latestVersion = packageJSON.version;

const cmdOutput = npmDistTag(packageName, latestVersion, "latest");
console.log(cmdOutput);
