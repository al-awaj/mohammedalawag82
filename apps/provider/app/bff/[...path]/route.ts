import { createBff } from '@events/web-kit/bff';

const bff = createBff({ apiUrl: process.env.API_URL ?? 'http://localhost:3000', kinds: ['provider'], cookiePrefix: 'prv', allowRegister: true });
export const { GET, POST, PUT, PATCH, DELETE } = bff;
export const dynamic = 'force-dynamic';
