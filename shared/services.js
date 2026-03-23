/**
 * TempEdge — Service Registry
 *
 * Single source of truth for all microservice endpoint URLs.
 * Every service imports this file instead of hardcoding URLs.
 *
 * URLs are resolved in order:
 *   1. Environment variable (set via K8s ConfigMap / .env)
 *   2. K8s DNS default (e.g. http://weather-svc:3002)
 *
 * Usage:
 *   import { services } from '../shared/services.js';
 *   const data = await fetch(`${services.dataSvc}/api/sessions`);
 */

const services = {
    weatherSvc: process.env.WEATHER_SVC_URL || 'http://weather-svc:3002',
    marketSvc: process.env.MARKET_SVC_URL || 'http://market-svc:3003',
    tradingSvc: process.env.TRADING_SVC_URL || 'http://trading-svc:3004',
    dataSvc: process.env.DATA_SVC_URL || 'http://data-svc:3005',
    liquiditySvc: process.env.LIQUIDITY_SVC_URL || 'http://liquidity-svc:3001',
};

export default services;
export { services };
