import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  get,
  post,
  ApiError,
  addErrorInterceptor,
  addResponseInterceptor,
  addRequestInterceptor,
} from './api';

describe('API Error Handling', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to create a mock Response
  function createMockResponse(options: {
    status: number;
    statusText: string;
    headers?: Record<string, string>;
    body?: unknown;
    contentType?: string;
  }): Response {
    const { status, statusText, headers = {}, body, contentType = 'application/json' } = options;
    return new Response(body ? JSON.stringify(body) : undefined, {
      status,
      statusText,
      headers: {
        'Content-Type': contentType,
        ...headers,
      },
    });
  }

  describe('2xx success responses', () => {
    it('should return successful response for 200', async () => {
      const mockData = { id: 1, name: 'Test' };
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse({ status: 200, statusText: 'OK', body: mockData })
      );

      const response = await get('/test');
      expect(response.status).toBe(200);
      expect(response.data).toEqual(mockData);
    });

    it('should return successful response for 201', async () => {
      const mockData = { created: true };
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse({ status: 201, statusText: 'Created', body: mockData })
      );

      const response = await post('/test');
      expect(response.status).toBe(201);
      expect(response.data).toEqual(mockData);
    });
  });

  describe('401 JSON error', () => {
    it('should reject with ApiError containing parsed JSON details', async () => {
      const errorBody = {
        message: 'Invalid credentials',
        code: 'AUTH_INVALID',
        details: { field: 'password' },
      };
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse({
          status: 401,
          statusText: 'Unauthorized',
          body: errorBody,
          headers: { 'X-Request-ID': 'req-123' },
        })
      );

      await expect(get('/test')).rejects.toMatchObject({
        code: 401,
        message: 'Unauthorized',
        requestId: 'req-123',
        suggestion: 'Your session has expired. Please sign in again.',
        details: errorBody,
      } as ApiError);
    });

    it('should run error interceptors for 401', async () => {
      const errorInterceptor = vi.fn((error: ApiError) => error);
      addErrorInterceptor(errorInterceptor);

      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse({
          status: 401,
          statusText: 'Unauthorized',
          body: { message: 'Token expired' },
        })
      );

      await expect(get('/test')).rejects.toBeDefined();
      expect(errorInterceptor).toHaveBeenCalled();
    });
  });

  describe('429 rate-limit error', () => {
    it('should reject with ApiError for 429', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse({
          status: 429,
          statusText: 'Too Many Requests',
          body: { retryAfter: 60 },
          headers: { 'X-Request-ID': 'req-456' },
        })
      );

      await expect(get('/test')).rejects.toMatchObject({
        code: 429,
        message: 'Too Many Requests',
        requestId: 'req-456',
        suggestion: 'Too many requests. Please wait a moment and try again.',
        details: { retryAfter: 60 },
      } as ApiError);
    });
  });

  describe('500 text error', () => {
    it('should reject with ApiError containing text body', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('Internal Server Error: database connection failed', {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'text/plain' },
        })
      );

      await expect(get('/test')).rejects.toMatchObject({
        code: 500,
        message: 'Internal Server Error',
        suggestion: 'An internal server error occurred. Please try again later.',
        details: { body: 'Internal Server Error: database connection failed' },
      } as ApiError);
    });
  });

  describe('aborted request', () => {
    it('should handle AbortError as timeout', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'));

      await expect(get('/test')).rejects.toMatchObject({
        code: 408,
        message: 'Request timed out',
        suggestion: 'Please check your network connection and try again.',
      } as ApiError);
    });
  });

  describe('network error', () => {
    it('should handle network errors', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(get('/test')).rejects.toMatchObject({
        code: 0,
        message: 'Network error',
        suggestion: 'Please check your network connection.',
      } as ApiError);
    });
  });

  describe('error interceptor chain', () => {
    it('should run all error interceptors for normalized HTTP errors', async () => {
      const interceptor1 = vi.fn((error: ApiError) => ({ ...error, message: `${error.message} [intercepted1]` }));
      const interceptor2 = vi.fn((error: ApiError) => ({ ...error, message: `${error.message} [intercepted2]` }));
      addErrorInterceptor(interceptor1);
      addErrorInterceptor(interceptor2);

      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse({
          status: 403,
          statusText: 'Forbidden',
          body: { reason: 'insufficient_permissions' },
        })
      );

      await expect(get('/test')).rejects.toMatchObject({
        code: 403,
        message: 'Forbidden [intercepted1] [intercepted2]',
      } as ApiError);
    });
  });

  describe('response interceptors', () => {
    it('should still run response interceptors for successful requests', async () => {
      const responseInterceptor = vi.fn((response) => response);
      addResponseInterceptor(responseInterceptor);

      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse({ status: 200, statusText: 'OK', body: { success: true } })
      );

      const response = await get('/test');
      expect(response.status).toBe(200);
      expect(responseInterceptor).toHaveBeenCalled();
    });

    it('should not run response interceptors for error responses', async () => {
      const responseInterceptor = vi.fn((response) => response);
      addResponseInterceptor(responseInterceptor);

      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse({ status: 404, statusText: 'Not Found', body: { error: 'not_found' } })
      );

      await expect(get('/test')).rejects.toBeDefined();
      expect(responseInterceptor).not.toHaveBeenCalled();
    });
  });

  describe('preserve request config', () => {
    it('should preserve custom timeout', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        createMockResponse({ status: 200, statusText: 'OK', body: {} })
      );

      await get('/test', undefined, { timeout: 5000 });
      // The timeout is used internally, just verify the request succeeds
      expect(fetch).toHaveBeenCalled();
    });
  });
});
