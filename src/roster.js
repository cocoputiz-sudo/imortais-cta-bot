/**
 * IMORTAIS CTA Bot - src/roster.js
 */
const { pt6teste, getComp } = require('./comps');

const activeRosters = {
  pt1: {},
  pt6teste: {}
};

function assignPlayer(partyId, slotNumber, playerObj) {
  if (!activeRosters[partyId]) activeRosters[partyId] = {};
  activeRosters[partyId][slotNumber] = playerObj;
}

function removePlayer(partyId, slotNumber) {
  if (activeRosters[partyId] && activeRosters[partyId][slotNumber]) {
    delete activeRosters[partyId][slotNumber];
  }
}

function getRoster(partyId) {
  return activeRosters[partyId] || {};
}

module.exports = {
  assignPlayer,
  removePlayer,
  getRoster
};
