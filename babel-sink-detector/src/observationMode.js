const { VERDICTS } = require('./constants');

const OBSERVATION_MODES = {
  STATIC_FINAL: 'static-final',
  CONTINUOUS: 'continuous',
};

function resolveObservationMode(verdict, argConstant) {
  if (verdict === VERDICTS.TYPE3) return OBSERVATION_MODES.CONTINUOUS;
  if (verdict === VERDICTS.TYPE5) return OBSERVATION_MODES.STATIC_FINAL;
  if (argConstant) return OBSERVATION_MODES.STATIC_FINAL;
  return OBSERVATION_MODES.CONTINUOUS;
}

module.exports = { OBSERVATION_MODES, resolveObservationMode };
