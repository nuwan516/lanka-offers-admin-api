import axios, { AxiosRequestConfig } from 'axios';
import { FileCache } from '../cache/file-cache';

export interface HttpClientConfig {
  timeout: number;
  retries: number;
  retryDelay: number;
  cache?: FileCache; // optional caching layer
}

export interface HttpResponse<T> {
  data: T;
  fromCache: boolean;
  status: number;
}

export class HttpClient {
  constructor(private config: HttpClientConfig) { }

  private async request<T>(url: string, options: AxiosRequestConfig, retryCount = 0): Promise<T> {
    try {
      const response = await axios.request<T>({
        ...options,
        url,
        timeout: this.config.timeout,
      });
      return response.data;
    } catch (error) {
      if (retryCount < this.config.retries) {
        await new Promise((resolve) => setTimeout(resolve, this.config.retryDelay * (retryCount + 1)));
        return this.request<T>(url, options, retryCount + 1);
      }
      throw error;
    }
  }

  async getJSON<T>(url: string): Promise<HttpResponse<T>> {
    // Check cache first
    if (this.config.cache) {
      const cached = this.config.cache.get<T>(url);
      if (cached) {
        return { data: cached, fromCache: true, status: 200 };
      }
    }

    const data = await this.request<T>(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'LankaOffers-Scraper/2.0',
        Accept: 'application/json',
      },
      responseType: 'json',
    });

    // Store in cache
    if (this.config.cache) {
      this.config.cache.set(url, data);
    }

    return { data, fromCache: false, status: 200 };
  }

  async getHTML(url: string): Promise<HttpResponse<string>> {
    if (this.config.cache) {
      const cached = this.config.cache.get<string>(url);
      if (cached) {
        return { data: cached, fromCache: true, status: 200 };
      }
    }

    // Full browser header set: WAFs (Seylan's AWS ALB, observed 2026-07-18)
    // reset connections from clients with sparse headers.
    const data = await this.request<string>(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      responseType: 'text',
    });

    if (this.config.cache) {
      this.config.cache.set(url, data);
    }

    return { data, fromCache: false, status: 200 };
  }

  async downloadBuffer(url: string): Promise<HttpResponse<Buffer>> {
    // Buffers usually aren't cached to avoid bloat; skip cache
    const data = await this.request<Buffer>(url, {
      method: 'GET',
      responseType: 'arraybuffer',
    });

    return { data, fromCache: false, status: 200 };
  }
}
