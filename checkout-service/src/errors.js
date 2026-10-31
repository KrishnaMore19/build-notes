export const errorBody = (code, message, details) => ({
  error: { code, message, ...(details ? { details } : {}) },
});
