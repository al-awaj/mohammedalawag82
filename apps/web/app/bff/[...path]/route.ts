import { createBff } from '@events/web-kit/bff';

const bff = createBff({ apiUrl: process.env.API_URL ?? 'http://localhost:3000', kinds: ['customer'], cookiePrefix: 'cst', allowRegister: true });
export const { GET, POST, PUT, PATCH, DELETE } = bff;
export const dynamic = 'force-dynamic';
