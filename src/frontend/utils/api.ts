/**
 * Centralized API fetch wrapper with consistent error handling
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Options for API fetch calls
 */
export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  /** Request body - will be JSON.stringify'd if object */
  body?: unknown;
  /** Whether to redirect to login on 401 (default: true) */
  redirectOnUnauthorized?: boolean;
  /** Whether to show toast on error (default: true for mutations) */
  showErrorToast?: boolean;
}

/**
 * Fetch wrapper with consistent error handling and auth redirect
 *
 * Features:
 * - Automatically includes credentials
 * - JSON serializes body if needed
 * - Redirects to login on 401 (configurable)
 * - Throws ApiError with status for error responses
 *
 * @example
 * // GET request
 * const data = await apiFetch<ClipPair>('/api/compare/pair');
 *
 * @example
 * // POST request with body
 * await apiFetch('/api/compare/vote', {
 *   method: 'POST',
 *   body: { clip_a_id: 1, clip_b_id: 2, result: 'clip_a' }
 * });
 */
export async function apiFetch<T>(
  url: string,
  options: ApiFetchOptions = {}
): Promise<T> {
  const {
    body,
    redirectOnUnauthorized = true,
    showErrorToast: _showErrorToast,
    ...fetchOptions
  } = options;

  // Build request options
  const requestInit: RequestInit = {
    credentials: 'include',
    ...fetchOptions,
  };

  // Handle body
  if (body !== undefined) {
    if (typeof body === 'string') {
      requestInit.body = body;
    } else {
      requestInit.body = JSON.stringify(body);
      requestInit.headers = {
        'Content-Type': 'application/json',
        ...requestInit.headers,
      };
    }
  }

  const response = await fetch(url, requestInit);

  // Handle unauthorized
  if (response.status === 401 && redirectOnUnauthorized) {
    window.location.href = '/api/auth/login';
    throw new ApiError('Unauthorized', 401);
  }

  // Handle error responses
  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = await response.text();
    }

    const message = typeof errorBody === 'object' && errorBody !== null && 'error' in errorBody
      ? String((errorBody as { error: unknown }).error)
      : `Request failed with status ${response.status}`;

    throw new ApiError(message, response.status, errorBody);
  }

  // Handle empty responses
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

/**
 * GET request helper
 */
export function apiGet<T>(url: string, options?: Omit<ApiFetchOptions, 'method' | 'body'>): Promise<T> {
  return apiFetch<T>(url, { ...options, method: 'GET' });
}

/**
 * POST request helper
 */
export function apiPost<T>(url: string, body?: unknown, options?: Omit<ApiFetchOptions, 'method' | 'body'>): Promise<T> {
  return apiFetch<T>(url, { ...options, method: 'POST', body });
}

/**
 * PUT request helper
 */
export function apiPut<T>(url: string, body?: unknown, options?: Omit<ApiFetchOptions, 'method' | 'body'>): Promise<T> {
  return apiFetch<T>(url, { ...options, method: 'PUT', body });
}

/**
 * DELETE request helper
 */
export function apiDelete<T>(url: string, options?: Omit<ApiFetchOptions, 'method'>): Promise<T> {
  return apiFetch<T>(url, { ...options, method: 'DELETE' });
}
