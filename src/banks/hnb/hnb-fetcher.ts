import { IFetcher } from '@/banks/fetcher';
import { HttpClient } from '@/infrastructure/http/http-client';
import { BankCategory } from '@/config/banks';

interface HNBListResponse {
  data: { id: string; title: string; from: string; to: string; cardType: string }[];
  totalPages: number;
}

export class HNBFetcher implements IFetcher {
  constructor(private http: HttpClient) {}

  async fetchList(category: BankCategory): Promise<unknown[]> {
    const firstUrl = category.url.replace('{page}', '1');
    const { data } = await this.http.getJSON<HNBListResponse>(firstUrl);

    const allItems = [...data.data];
    const totalPages = data.totalPages;

    if (totalPages > 1) {
      const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const results = await Promise.all(
        remainingPages.map(page => {
          const url = category.url.replace('{page}', String(page));
          return this.http.getJSON<HNBListResponse>(url);
        })
      );
      results.forEach(res => allItems.push(...res.data.data));
    }

    return allItems;
  }

  async fetchDetail(rawItem: unknown): Promise<unknown> {
    const item = rawItem as { id: string };
    const id = item.id;
    const url = `https://venus.hnb.lk/api/get_web_card_promo?id=${id}`;
    const resp = await this.http.getJSON<Record<string, unknown>>(url);
    return { ...resp.data, _listItem: rawItem };
  }
}
