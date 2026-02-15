export const getTableStackApiUrl = () => {
  const isDev = process.env.NODE_ENV === 'development';
  return process.env.TABLESTACK_API_URL || (isDev ? 'http://localhost:3005/api/v1' : 'https://table-stack.vercel.app/api/v1');
};

export const getInternalSystemKey = () => process.env.INTERNAL_SYSTEM_KEY || 'vi3tnam';
