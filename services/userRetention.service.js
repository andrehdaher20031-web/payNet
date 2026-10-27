const Activity = require('../models/UserActivity');
const Operation = require('../models/UserOperation');
const FollowUp = require('../models/UserFollowUp');
const DAY = 86400000;
const intentTypes = ['product_view', 'quote_created', 'checkout_started', 'checkout_failed'];

function stages(config, now) {
  const recent = new Date(+now - 30 * DAY);
  return [
    { $lookup: { from: FollowUp.collection.name, localField: '_id', foreignField: '_id',
      pipeline: [{ $project: { history: 0 } }], as: 'followUps' } },
    { $lookup: { from: Activity.collection.name, localField: '_id', foreignField: 'user', pipeline: [
      { $match: { eventType: { $in: intentTypes }, occurredAt: { $gte: recent } } },
      { $sort: { occurredAt: -1, _id: -1 } }, { $limit: 1 },
    ], as: 'intents' } },
    { $lookup: { from: Operation.collection.name, localField: '_id', foreignField: 'user', pipeline: [
      { $match: { kind: 'purchase', status: 'completed' } },
      { $group: { _id: { provider: '$provider', productId: '$productId', name: '$productName' }, count: { $sum: 1 }, lastAt: { $max: '$occurredAt' } } },
      { $sort: { count: -1, lastAt: -1 } }, { $limit: 1 },
    ], as: 'favorites' } },
    { $set: {
      followUp: { $ifNull: [{ $first: '$followUps' }, { status: 'new', owner: null, dueAt: null, confirmedGoal: '', dropOffReason: 'unknown', revision: 0 }] },
      intent: { $first: '$intents' }, favoriteProduct: { $first: '$favorites' },
      'retention.successfulPurchases': '$stats.successfulPurchases',
      'retention.firstPurchaseAt': '$stats.firstPurchaseAt', 'retention.lastPurchaseAt': '$stats.lastPurchaseAt',
      'retention.recentPurchases': '$stats.recentPurchases', 'retention.previousPurchases': '$stats.previousPurchases',
      'retention.averageOrderSyp': { $cond: [{ $gt: ['$stats.successfulPurchases', 0] },
        { $toString: { $divide: [{ $toDecimal: '$stats.spent' }, '$stats.successfulPurchases'] } }, null] },
      'retention.averageGapDays': { $cond: [{ $gt: ['$stats.successfulPurchases', 1] },
        { $divide: [{ $subtract: ['$stats.lastPurchaseAt', '$stats.firstPurchaseAt'] }, { $multiply: [{ $subtract: ['$stats.successfulPurchases', 1] }, DAY] }] }, null] },
      'retention.daysSincePurchase': { $cond: [{ $gt: ['$stats.successfulPurchases', 0] },
        { $floor: { $divide: [{ $subtract: [now, '$stats.lastPurchaseAt'] }, DAY] } }, null] },
    } },
    { $lookup: { from: Operation.collection.name, let: { user: '$_id', intent: '$intent' }, pipeline: [
      { $match: { $expr: { $and: [
        { $eq: ['$user', '$$user'] }, { $eq: ['$kind', 'purchase'] },
        { $gte: ['$occurredAt', { $subtract: ['$$intent.occurredAt', 5000] }] }, { $eq: ['$provider', '$$intent.provider'] },
        { $or: [
          { $and: [{ $ne: [{ $ifNull: ['$$intent.productId', ''] }, ''] }, { $eq: ['$productId', '$$intent.productId'] }] },
          { $and: [{ $ne: [{ $ifNull: ['$$intent.productName', ''] }, ''] }, { $eq: ['$productName', '$$intent.productName'] }] },
        ] },
      ] } } }, { $sort: { occurredAt: -1, _id: -1 } }, { $limit: 1 },
    ], as: 'intentOperations' } },
    { $lookup: { from: Activity.collection.name, let: { user: '$_id', intent: '$intent' }, pipeline: [
      { $match: { eventType: { $in: ['request_failed', 'request_accepted'] }, $expr: { $and: [
        { $eq: ['$user', '$$user'] }, { $eq: ['$provider', '$$intent.provider'] },
        { $gte: ['$occurredAt', { $subtract: ['$$intent.occurredAt', 5000] }] },
        { $or: [{ $eq: ['$productId', '$$intent.productId'] },
          { $and: [{ $in: ['$$intent.eventType', ['checkout_started', 'quote_created']] },
            { $lte: ['$occurredAt', { $add: ['$$intent.occurredAt', 30 * 60000] }] },
            { $regexMatch: { input: { $ifNull: ['$route', ''] }, regex: '(order|purchase|internet-full|request)' } }] }] },
      ] } } }, { $sort: { occurredAt: -1, _id: -1 } }, { $limit: 1 },
    ], as: 'intentRequests' } },
    { $set: { intentOperation: { $first: '$intentOperations' }, intentRequest: { $first: '$intentRequests' },
      followUpDue: { $and: [{ $ne: ['$followUp.status', 'resolved'] }, { $ne: ['$followUp.dueAt', null] }, { $lte: ['$followUp.dueAt', now] }] },
      purchaseDecline: { $and: [{ $gte: ['$stats.previousPurchases', 2] }, { $lt: ['$stats.recentPurchases', { $multiply: ['$stats.previousPurchases', 0.5] }] }] },
    } },
    { $set: { goalStage: { $switch: { branches: [
      { case: { $eq: [{ $ifNull: ['$intent', null] }, null] }, then: 'unknown' },
      { case: { $eq: ['$intentOperation.status', 'completed'] }, then: 'completed' },
      { case: { $eq: ['$intentOperation.status', 'pending'] }, then: 'pending' },
      { case: { $in: ['$intentOperation.status', ['failed', 'refunded', 'mismatch']] }, then: 'blocked' },
      { case: { $eq: ['$intent.eventType', 'checkout_failed'] }, then: 'blocked' },
      { case: { $eq: ['$intentRequest.eventType', 'request_failed'] }, then: 'blocked' },
      { case: { $eq: ['$intentRequest.eventType', 'request_accepted'] }, then: 'submitted' },
      { case: { $and: [{ $in: ['$intent.eventType', ['quote_created', 'checkout_started']] },
        { $lt: ['$intent.occurredAt', new Date(+now - 30 * 60000)] }] }, then: 'abandoned' },
      { case: { $eq: ['$intent.eventType', 'checkout_started'] }, then: 'checkout' },
      { case: { $eq: ['$intent.eventType', 'quote_created'] }, then: 'pricing' },
    ], default: 'browsing' } },
      'retention.segment': { $switch: { branches: [
        { case: { $gte: ['$stats.successfulPurchases', 2] }, then: 'repeat' },
        { case: { $eq: ['$stats.successfulPurchases', 1] }, then: 'first_purchase' },
        { case: { $eq: [{ $ifNull: ['$lastSeenAt', null] }, null] }, then: 'unobserved' },
      ], default: 'prospect' } },
    } },
    { $set: { 'retention.risk': { $switch: { branches: [
      { case: { $and: [{ $gt: ['$stats.successfulPurchases', 0] },
        { $gte: ['$retention.daysSincePurchase', { $max: [config.inactiveDays * 2, { $multiply: [{ $ifNull: ['$retention.averageGapDays', 0] }, 2] }] }] },
        { $eq: ['$activityStatus', 'inactive'] }] }, then: 'high' },
      { case: { $or: ['$needsAttention', '$purchaseDecline', { $in: ['$goalStage', ['abandoned', 'blocked']] },
        { $and: [{ $gt: ['$stats.successfulPurchases', 0] }, { $eq: ['$activityStatus', 'inactive'] }] }] }, then: 'medium' },
      { case: { $and: [{ $eq: ['$stats.successfulPurchases', 0] }, { $eq: ['$activityStatus', 'unobserved'] }] }, then: 'unknown' },
    ], default: 'low' } },
      'retention.reasons': { $concatArrays: [
        { $cond: [{ $eq: ['$activityStatus', 'inactive'] }, ['inactive'], []] },
        { $cond: ['$purchaseDecline', ['purchase_decline'], []] },
        { $cond: ['$needsAttention', ['operation_issue'], []] },
        { $cond: [{ $eq: ['$goalStage', 'abandoned'] }, ['incomplete_checkout'], []] },
        { $cond: [{ $eq: ['$goalStage', 'blocked'] }, ['purchase_blocked'], []] },
      ] },
    } },
    { $set: { followUpPriority: { $switch: { branches: [
      { case: { $or: ['$followUpDue', { $eq: ['$retention.risk', 'high'] }] }, then: 3 },
      { case: { $or: ['$needsAttention', { $eq: ['$goalStage', 'blocked'] }] }, then: 2 },
      { case: { $eq: ['$retention.risk', 'medium'] }, then: 1 },
    ], default: 0 } } } },
    { $unset: ['followUps', 'intents', 'favorites', 'intentOperations', 'intentRequests'] },
  ];
}

function present(user) {
  if (!user) return user;
  const evidence = user.intent;
  const operation = user.intentOperation;
  const request = user.intentRequest;
  const goal = {
    stage: user.goalStage || 'unknown', provider: evidence?.provider,
    productId: evidence?.productId, productName: evidence?.productName,
    occurredAt: evidence?.occurredAt, evidenceType: evidence?.eventType,
    confidence: evidence ? ['checkout_started', 'quote_created', 'checkout_failed'].includes(evidence.eventType) ? 'strong' : 'limited' : 'unknown',
    errorCode: operation?.errorCode || request?.errorCode || evidence?.errorCode,
    operationId: operation?._id, referenceId: operation?.referenceId || request?.referenceId,
  };
  const { intent, intentOperation, intentRequest, goalStage, ...rest } = user;
  return { ...rest, goal };
}

function journeyPipeline(user, q, dateFilter) {
  return [
    { $match: { user, source: { $ne: 'history' }, eventType: { $nin: ['admin_action', 'login_failed', 'operation_recorded', 'operation_updated'] } } },
    { $setWindowFields: { sortBy: { occurredAt: 1, _id: 1 }, output: {
      previousAt: { $shift: { output: '$occurredAt', by: -1, default: null } },
      previousType: { $shift: { output: '$eventType', by: -1, default: null } },
    } } },
    { $set: { sessionBreak: { $cond: [{ $or: [
      { $eq: ['$previousAt', null] }, { $gt: [{ $subtract: ['$occurredAt', '$previousAt'] }, 30 * 60000] },
      { $eq: ['$previousType', 'logout'] }, { $eq: ['$eventType', 'login_success'] },
    ] }, 1, 0] } } },
    { $setWindowFields: { sortBy: { occurredAt: 1, _id: 1 }, output: {
      session: { $sum: '$sessionBreak', window: { documents: ['unbounded', 'current'] } },
    } } },
    { $unset: ['previousAt', 'previousType', 'sessionBreak'] },
    { $group: { _id: '$session', startedAt: { $min: '$occurredAt' }, endedAt: { $max: '$occurredAt' },
      count: { $sum: 1 }, providers: { $addToSet: '$provider' }, events: { $firstN: { input: '$$ROOT', n: 200 } } } },
    { $match: { ...(dateFilter.occurredAt?.$gte ? { endedAt: { $gte: dateFilter.occurredAt.$gte } } : {}),
      ...(dateFilter.occurredAt?.$lt ? { startedAt: { $lt: dateFilter.occurredAt.$lt } } : {}), ...(q.provider ? { providers: q.provider } : {}) } },
    { $sort: { startedAt: -1, _id: -1 } },
    { $facet: { data: [{ $skip: (q.page - 1) * q.limit }, { $limit: q.limit },
      { $project: { startedAt: 1, endedAt: 1, count: 1, events: { $slice: ['$events', 200] }, providers: 1 } }], total: [{ $count: 'count' }] } },
  ];
}

module.exports = { stages, present, journeyPipeline };
