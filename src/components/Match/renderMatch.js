import {
  isRadiant,
  isSupport,
  getLevelFromXp,
  unpackPositionData,
} from 'utility';
import heroes from 'dotaconstants/json/heroes.json';
import immutable from 'seamless-immutable';
import _ from 'lodash/fp';
import strings from 'lang';
import analysis from './analysis';

const expanded = {};
Object.keys(strings)
  .filter(str => str.indexOf('npc_dota_') === 0)
  .forEach((key) => {
  // Currently, no unit goes up higher than 4
    for (let i = 1; i < 5; i += 1) {
      expanded[key.replace('#', i)] = strings[key];
    }
  });

const getMaxKeyOfObject = field =>
 (field ? Object.keys(field).sort((a, b) => Number(b) - Number(a))[0] : '');

/**
 * Generates data for c3 charts in a match
 **/
function generateGraphData(match) {
  if (match.players && match.players[0] && match.radiant_gold_adv && match.radiant_xp_adv) {
    // compute graphs
    const goldDifference = ['Gold', ...match.radiant_gold_adv];
    const xpDifference = ['XP', ...match.radiant_xp_adv];
    const time = ['time', ...match.players[0].times];
    const data = {
      difference: [time, xpDifference, goldDifference],
      gold: [time],
      xp: [time],
      lh: [time],
    };
    match.players.forEach((player) => {
      let hero = heroes[player.hero_id] || {};
      hero = hero.localized_name;
      if (player.gold_t) {
        data.gold.push([hero, ...player.gold_t]);
      }
      if (player.xp_t) {
        data.xp.push([hero, ...player.xp_t]);
      }
      if (player.lh_t) {
        data.lh.push([hero, ...player.lh_t]);
      }
    });
    return data;
  }
  return {};
}

function generateTeamfights({ players, teamfights = [] }) {
  const computeTfData = (tf) => {
    const newtf = {
      ...tf,
      deaths_pos: [],
      radiant_gold_advantage_delta: 0,
      radiant_gold_delta: 0,
      dire_gold_delta: 0,
      radiant_xp_delta: 0,
      radiant_participation: 0,
      radiant_deaths: 0,
      dire_participation: 0,
      dire_deaths: 0,
    };
    newtf.players = players.map((player) => {
      const tfplayer = tf.players[player.player_slot % (128 - 5)];
      // compute team gold/xp deltas
      if (isRadiant(player.player_slot)) {
        newtf.radiant_gold_advantage_delta += tfplayer.gold_delta;
        newtf.radiant_gold_delta += tfplayer.gold_delta;
        newtf.radiant_xp_delta += tfplayer.xp_delta;
        newtf.radiant_participation += tfplayer.participate ? 1 : 0;
        newtf.radiant_deaths += tfplayer.deaths ? 1 : 0;
      } else {
        newtf.radiant_gold_advantage_delta -= tfplayer.gold_delta;
        newtf.dire_gold_delta -= tfplayer.gold_delta;
        newtf.radiant_xp_delta -= tfplayer.xp_delta;
        newtf.dire_participation += tfplayer.participate ? 1 : 0;
        newtf.dire_deaths += tfplayer.deaths ? 1 : 0;
      }
      const playerDeathsPos = unpackPositionData(tfplayer.deaths_pos)
        .map(deathPos => ({
          ...deathPos,
          isRadiant: isRadiant(player.player_slot),
          player,
        }));
      newtf.deaths_pos = newtf.deaths_pos.concat(playerDeathsPos);
      return {
        ...player,
        ...tfplayer,
        participate: tfplayer.deaths > 0 || tfplayer.damage > 0, // || tfplayer.healing > 0,
        level_start: getLevelFromXp(tfplayer.xp_start),
        level_end: getLevelFromXp(tfplayer.xp_end),
        deaths_pos: playerDeathsPos,
      };
    });
    // We have to do this after we process the stuff so that we will have the player in
    // the data instead of just the 'teamfight player' which doesn't have enough data.
    newtf.deaths_pos = newtf.deaths_pos
      .map(death => ([{
        ...death,
        killer: newtf.players
          .find(killer => heroes[death.player.hero_id] && killer.killed[heroes[death.player.hero_id].name]),
      }]))
      .reduce(
        (newDeathsPos, death) => {
          const copy = [...newDeathsPos];
          const samePosition = copy
            .findIndex((deathPos) => {
              const cursor = deathPos[0];
              return cursor.x === death[0].x && cursor.y === death[0].y;
            });
          if (samePosition !== -1) {
            copy[samePosition] = copy[samePosition].concat(death);
          } else {
            copy.push(death);
          }
          return copy;
        },
        [],
      );
    return newtf;
  };
  return (teamfights || []).map(computeTfData);
}

// create a detailed history of each wards
function generateVisionLog(match) {
  const computeWardData = (player, i) => {
    const sameWard = _.curry((w1, w2) => w1.ehandle === w2.ehandle);

    // let's coerce some value to be sure the structure is what we expect.
    const safePlayer = {
      ...player,
      obs_log: player.obs_log || [],
      sen_log: player.sen_log || [],
      obs_left_log: player.obs_left_log || [],
      sen_left_log: player.sen_left_log || [],
    };

    // let's zip the *_log and the *_left log in a 2-tuples
    const extractVisionLog = (type, enteredLog, leftLog) =>
      enteredLog.map((e) => {
        const wards = [e, leftLog.find(sameWard(e))];
        return {
          player: i,
          key: wards[0].ehandle,
          type,
          entered: wards[0],
          left: wards[1],
        };
      })
    ;

    const observers = extractVisionLog('observer', safePlayer.obs_log, safePlayer.obs_left_log);
    const sentries = extractVisionLog('sentry', safePlayer.sen_log, safePlayer.sen_left_log);
    return _.concat(observers, sentries);
  };

  const imap = _.map.convert({ cap: false }); // cap: false to keep the index
  const visionLog = _.flow(
    imap(computeWardData),
    _.flatten,
    _.sortBy(xs => xs.entered.time),
    imap((x, i) => ({ ...x, key: i })),
  );

  return visionLog(match.players || []);
}

function renderMatch(m) {
  const newPlayers = m.players.map((player) => {
    const newPlayer = {
      ...player,
      desc: [strings[`lane_role_${player.lane_role}`], isSupport(player) ? 'Support' : 'Core'].join('/'),
      multi_kills_max: getMaxKeyOfObject(player.multi_kills),
      kill_streaks_max: getMaxKeyOfObject(player.kill_streaks),
      analysis: analysis(m, player),
    };
    // filter interval data to only be >= 0
    if (player.times) {
      const intervals = ['lh_t', 'gold_t', 'xp_t', 'times'];
      intervals.forEach((key) => {
        newPlayer[key] = player[key].filter((el, i) => player.times[i] >= 0);
      });
    }
    // compute damage to towers/rax/roshan
    if (player.damage) {
      // npc_dota_goodguys_tower2_top
      // npc_dota_goodguys_melee_rax_top
      // npc_dota_roshan
      // npc_dota_neutral_giant_wolf
      // npc_dota_creep
      newPlayer.objective_damage = {};
      Object.keys(player.damage).forEach((key) => {
        let identifier = null;
        if (key.indexOf('tower') !== -1) {
          identifier = key.split('_').slice(3).join('_');
        }
        if (key.indexOf('rax') !== -1) {
          identifier = key.split('_').slice(4).join('_');
        }
        if (key.indexOf('roshan') !== -1) {
          identifier = 'roshan';
        }
        if (key.indexOf('fort') !== -1) {
          identifier = 'fort';
        }
        newPlayer.objective_damage[identifier] = newPlayer.objective_damage[identifier] ?
                                                 newPlayer.objective_damage[identifier] + player.damage[key] :
                                                 player.damage[key];
      });
    }
    if (player.killed) {
      newPlayer.specific = {};
      // expand keys in specific by # (1-4)
      // map to friendly name
      // iterate through keys in killed
      // if in expanded, put in pm.specific
      Object.keys(player.killed).forEach((key) => {
        if (key in expanded) {
          const name = expanded[key];
          newPlayer.specific[name] = newPlayer.specific[name] ? newPlayer.specific[name] + newPlayer.killed[key] : newPlayer.killed[key];
        }
      });
    }
    if (player.purchase) {
      newPlayer.purchase_tpscroll = player.purchase.tpscroll;
      newPlayer.purchase_ward_observer = player.purchase.ward_observer;
      newPlayer.purchase_ward_sentry = player.purchase.ward_sentry;
      newPlayer.purchase_smoke_of_deceit = player.purchase.smoke_of_deceit;
      newPlayer.purchase_dust = player.purchase.dust;
      newPlayer.purchase_gem = player.purchase.gem;
    }
    return newPlayer;
  });

  const newObjectives = (m.objectives || []).map((obj) => {
    if (obj.slot > 0) {
      return {
        ...obj,
        player_slot: obj.slot > 4 ? obj.slot + 123 : obj.slot,
      };
    }
    return {
      ...obj,
    };
  });

  return {
    ...m,
    graphData: generateGraphData(m),
    teamfights: generateTeamfights(m),
    players: newPlayers,
    wards_log: generateVisionLog(immutable(m)),
    objectives: newObjectives,
  };
}

export default renderMatch;
