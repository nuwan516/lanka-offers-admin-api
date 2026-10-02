import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, HNB_CATEGORIES } from '@/config/banks';
import { HNBListItem, HNBDetailResponse, parseHNBDetail } from './hnb-parser';

export class HNBScraper extends BaseScraper {
    readonly bankName = 'hnb';
    readonly categories = HNB_CATEGORIES;

    constructor(config: ScraperConfig) {
        super(config);
    }

    protected async fetchCategoryRawData(category: BankCategory): Promise<HNBListItem[]> {
        const firstPageUrl = category.url.replace('{page}', '1');
        const { data } = await this.http.getJSON<{ data: HNBListItem[]; totalPages: number }>(firstPageUrl);

        const allItems = data.data.map(item => ({
            ...item,
            categoryName: category.name,
            categoryId: category.id,
        }));
        const totalPages = data.totalPages || 1;

        if (totalPages > 1) {
            const pageUrls: string[] = [];
            for (let page = 2; page <= totalPages; page++) {
                pageUrls.push(category.url.replace('{page}', String(page)));
            }
            const results = await this.pool.all(
                pageUrls.map(url => async () => {
                    const resp = await this.http.getJSON<{ data: HNBListItem[] }>(url);
                    return resp.data.data.map(item => ({
                        ...item,
                        categoryName: category.name,
                        categoryId: category.id,
                    }));
                })
            );
            results.forEach(items => allItems.push(...items));
        }

        return allItems;
    }

    protected async fetchItemDetail(rawItem: unknown): Promise<{ item: HNBListItem; detail: HNBDetailResponse } | null> {
        const item = rawItem as HNBListItem;
        const url = `https://venus.hnb.lk/api/get_web_card_promo?id=${item.id}`;
        try {
            const resp = await this.http.getJSON<HNBDetailResponse>(url);
            return { item, detail: resp.data };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn('Detail', `Failed to fetch detail for ${item.id}: ${message}`);
            return null;
        }
    }

    protected buildOffer(raw: { item: HNBListItem; detail: HNBDetailResponse } | null): Offer | null {
        if (!raw) return null;
        // Determine category name from the scraper's category context?
        // We'll pass category info via a closure or store it. For simplicity, we'll add category info to the raw object.
        // We'll modify fetchAllDetails to include category.
        // But BaseScraper's processCategory calls fetchAllDetails on the rawItems, which now contain category info.
        // Let's adjust: we'll embed category into each raw item.
        return parseHNBDetail(raw.item.id, raw.detail, raw.item.categoryName ?? 'General', raw.item.categoryId ?? 0);
    }
}
