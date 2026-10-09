import Ajv from 'ajv';
import {SHAPES,DIG_SHAPES} from './blueprints.mjs';
export const ACTION_TYPES=['wait','move','pathfind','chat','interact','attack','tell','place','break','build','blueprint','give','equip',
  'mine','dig','farm','breed','craft','smelt','propose','vote','record','appraise','quest','zone','mediate','eat','deposit','withdraw','goal',
  'preach','attempt_conversion','practice_hobby','cultural_festival','claim_quest','progress_quest','turn_in_quest','complain','pardon','deposit_emeralds','withdraw_emeralds','get_balance','stash','take_from_chest'];
// Must match build-reach in the plugin config (blocks from the agent's feet).
export const BUILD_REACH=Number(process.env.BUILD_REACH||10);
export const actionSchema = {
  type:'object', additionalProperties:false,
  required:['type','x','y','z','target','text','to','blocks','count','spec'],
  properties:{
    type:{enum:ACTION_TYPES},
    x:{type:'number',minimum:-30000000,maximum:30000000},
    y:{type:'number',minimum:-2048,maximum:2048},
    z:{type:'number',minimum:-30000000,maximum:30000000},
    target:{type:'string',maxLength:64},text:{type:'string',maxLength:240},
    to:{type:'string',maxLength:32},
    // build: up to 16 blocks placed in one turn; each needs its own x,y,z and material name.
    blocks:{type:'array',maxItems:16,items:{type:'object',additionalProperties:false,required:['x','y','z','block'],
      properties:{x:{type:'integer'},y:{type:'integer'},z:{type:'integer'},block:{type:'string',maxLength:64}}}},
    // give: number of items.
    count:{type:'integer',minimum:1,maximum:64},
    // blueprint: shape description expanded by blueprints.mjs; x,y,z is its minimum corner.
    spec:{type:'object',properties:{
      shape:{type:'string',maxLength:16},width:{type:'number'},depth:{type:'number'},height:{type:'number'},
      material:{type:'string',maxLength:64},trim:{type:'string',maxLength:64},roof:{type:'string',maxLength:64},
      floor:{type:'string',maxLength:64},door:{type:['string','boolean']},windows:{type:'boolean'},
      x2:{type:'number'},z2:{type:'number'},direction:{type:'string',maxLength:8},length:{type:'number'},crop:{type:'string',maxLength:32},
      ground:{type:'boolean'},kind:{type:'string',maxLength:16},name:{type:'string',maxLength:40}}}
  }
};
export const planSchema = {
  type:'object', additionalProperties:false, required:['reflection','plan','action'],
  properties:{reflection:{type:'string',maxLength:1000},plan:{type:'string',maxLength:1000},action:actionSchema}
};
const ajv = new Ajv({allErrors:true,allowUnionTypes:true});
export const validatePlan = ajv.compile(planSchema);
export function assertAction(action, self, agentIds) {
  if (!ajv.validate(actionSchema, action)) throw Error('Invalid action schema');
  if (['move','pathfind','interact'].includes(action.type)) {
    const distance = Math.hypot(action.x-self.x,action.y-self.y,action.z-self.z);
    if (distance > (action.type==='interact'?4:24)) throw Error('Target out of range');
  }
  const reach=b=>Math.hypot(b.x+0.5-self.x,b.y+0.5-self.y,b.z+0.5-self.z)<=BUILD_REACH+0.5;
  if (['place','break'].includes(action.type) && !reach(action)) throw Error(`Block out of reach; stand within ${BUILD_REACH} blocks first`);
  if (action.type==='build') {
    if (!action.blocks.length) throw Error('build needs at least one block');
    if (!action.blocks.every(reach)) throw Error(`Some build blocks are out of reach; build within ${BUILD_REACH} blocks of yourself`);
  }
  if (action.type==='blueprint' && !SHAPES.includes(String(action.spec.shape).toLowerCase()))
    throw Error(`blueprint needs spec.shape, one of ${SHAPES.join(', ')}`);
  if (action.type==='give' && (!action.to || !action.target)) throw Error('give needs the item in target and the recipient in to');
  if (action.type==='mine' && !reach(action)) throw Error(`Block out of reach; stand within ${BUILD_REACH} blocks first`);
  if (action.type==='dig' && !DIG_SHAPES.includes(String(action.spec.shape).toLowerCase())) throw Error('dig needs spec.shape "stairs", "tunnel" or "cancel"');
  if (['breed','craft','smelt','appraise'].includes(action.type) && !action.target) throw Error(`${action.type} needs target`);
  if (['propose','record'].includes(action.type) && action.text.trim().length<3) throw Error(`${action.type} needs text`);
  if (action.type==='vote' && (!action.target || !/^(yes|no)$/i.test(action.text.trim()))) throw Error('vote needs the proposal id in target and text "yes" or "no"');
  if (action.type==='equip' && !action.target) throw Error('equip needs the item name in target (or NONE)');
  if (['quest','deposit','withdraw'].includes(action.type) && !action.target) throw Error(`${action.type} needs the item in target`);
  if (action.type==='zone' && (!action.spec.kind || action.spec.x2===undefined || action.spec.z2===undefined)) throw Error('zone needs spec.kind and the opposite corner in spec.x2, spec.z2');
  if (action.type==='attempt_conversion' && (!action.to || !agentIds.includes(action.to) || action.to===self.id)) throw Error('attempt_conversion needs a fellow citizen id in to');
  if (action.type==='mediate' && (!action.target.includes(',') || action.text.trim().length<3)) throw Error('mediate needs target "agentA,agentB" and the agreement in text');
  if (['claim_quest','progress_quest','turn_in_quest'].includes(action.type) && !/^#?\d+$/.test(String(action.target).trim())) throw Error(`${action.type} needs the quest number in target`);
  if (action.type==='complain' && (!agentIds.includes(action.to) || action.to===self.id || action.text.trim().length<3)) throw Error('complain needs a fellow citizen id in to and what happened in text');
  if (action.type==='pardon' && !agentIds.includes(action.to)) throw Error('pardon needs the citizen id in to');
  if (['stash','take_from_chest'].includes(action.type) && !action.target) throw Error(`${action.type} needs the item in target`);
  if (action.type==='take_from_chest' && action.to && !agentIds.includes(action.to)) throw Error('take_from_chest: to is the owner (a citizen id), or empty for your own chest');
  if (action.type==='attack' && !self.entities.some(e=>e.uuid===action.target && e.type!=='PLAYER'))
    throw Error('Attack target not observed or is a player');
  if (action.type==='tell' && (!agentIds.includes(action.to) || action.to===self.id))
    throw Error('Unknown teammate');
  return action;
}
