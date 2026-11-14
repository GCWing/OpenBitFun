const CHANNELS = {
  stable: {
    primaryUpdaterEndpoint:
      'https://github.com/openBitFun/OpenBitFun/releases/latest/download/latest-v1.json',
    fallbackUpdaterEndpoint: 'https://openbitfun.com/release/latest-v1.json',
    githubChannelTag: null,
  },
  beta: {
    primaryUpdaterEndpoint:
      'https://github.com/openBitFun/OpenBitFun/releases/download/channel-v1-beta/latest-v1.json',
    fallbackUpdaterEndpoint: 'https://openbitfun.com/release/beta/latest-v1.json',
    githubChannelTag: 'channel-v1-beta',
  },
  nightly: {
    primaryUpdaterEndpoint:
      'https://github.com/openBitFun/OpenBitFun/releases/download/nightly/latest-v1.json',
    fallbackUpdaterEndpoint: 'https://openbitfun.com/release/nightly/latest-v1.json',
    githubChannelTag: 'nightly',
  },
};

export function resolveReleaseChannel(value = 'stable') {
  const channel = String(value || 'stable').trim().toLowerCase();
  const config = CHANNELS[channel];
  if (!config) {
    throw new Error(
      `Unsupported release channel "${value}". Expected one of: ${Object.keys(CHANNELS).join(', ')}`,
    );
  }
  return { channel, ...config };
}

export function validateReleaseVersion(channelValue, versionValue) {
  const { channel } = resolveReleaseChannel(channelValue);
  const version = String(versionValue || '').trim();
  const stablePattern = /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const betaPattern =
    /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;
  const nightlyPattern =
    /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.\d{8}$/;
  // The 1.0 launch keeps its beta spelling but is a public Latest release.
  // Numbered beta candidates still require the prerelease channel.
  const valid = channel === 'stable'
    ? (stablePattern.test(version) || version === '1.0.0-beta')
    : channel === 'beta'
      ? betaPattern.test(version)
      : nightlyPattern.test(version);
  if (!valid) {
    const example = channel === 'stable'
      ? '1.0.0'
      : channel === 'beta'
        ? '1.0.0-beta.1'
        : '1.0.0-nightly.20260811';
    throw new Error(
      `Version "${versionValue}" is invalid for the ${channel} channel. Expected a version like ${example}`,
    );
  }
  return version;
}

export function compareReleaseVersions(leftValue, rightValue) {
  const left = parseComparableVersion(leftValue);
  const right = parseComparableVersion(rightValue);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.beta === right.beta) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return left.beta < right.beta ? -1 : 1;
}

function parseComparableVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta(?:\.([1-9]\d*))?)?$/.exec(String(value));
  if (!match) {
    throw new Error(`Unsupported channel version: ${value}`);
  }
  return {
    core: match.slice(1, 4).map(Number),
    beta: String(value).includes('-beta') ? Number(match[4] || 0) : null,
  };
}
