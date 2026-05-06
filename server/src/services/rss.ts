import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { feeds, users } from "../db/schema";
import { extractImage } from "../utils/image";
import { path_join } from "../utils/path";
import { getStorageObject, getStoragePublicUrl, headStorageObject, putStorageObjectAtKey } from "../utils/storage";
import { FAVICON_ALLOWED_TYPES, getFaviconKey } from "./favicon";
import type { DB } from "../core/hono-types";

// Lazy-loaded modules for RSS generation
let Feed: any;
let unified: any;
let remarkParse: any;
let remarkGfm: any;
let remarkRehype: any;
let rehypeStringify: any;

async function initRSSModules() {
    if (!Feed) {
        const feed = await import("feed");
        Feed = feed.Feed;
    }
    if (!unified) {
        const [u, rp, rg, rr, rs] = await Promise.all([
            import("unified"),
            import("remark-parse"),
            import("remark-gfm"),
            import("remark-rehype"),
            import("rehype-stringify")
        ]);
        unified = u.unified;
        remarkParse = rp.default;
        remarkGfm = rg.default;
        remarkRehype = rr.default;
        rehypeStringify = rs.default;
    }
}

export function RSSService(): Hono {
    const app = new Hono();
    const handlers = ['/rss.xml', '/atom.xml', '/rss.json', '/feed.json'];
    handlers.forEach(path => {
        app.get(path, (c: AppContext) => handleFeed(c, path.split('/').pop()!));
    });
    app.get('/feed.xml', (c: AppContext) => c.redirect('/rss.xml', 301));
    return app;
}

async function handleFeed(c: AppContext, fileName: string) {
    const env = c.get('env');
    const db = c.get('db');
    const folder = env.S3_CACHE_FOLDER || 'cache/';
    const contentTypeMap: Record<string, string> = {
        'rss.xml': 'application/rss+xml; charset=UTF-8',
        'atom.xml': 'application/atom+xml; charset=UTF-8',
        'rss.json': 'application/feed+json; charset=UTF-8',
        'feed.json': 'application/feed+json; charset=UTF-8',
    };
    const key = path_join(folder, fileName);
    
    try {
        const response = await profileAsync(c, 'rss_s3_fetch', () => getStorageObject(env, key));
        if (response) {
            const text = await response.text();
            return c.text(text, 200, { 'Content-Type': contentTypeMap[fileName] || 'application/xml', 'Cache-Control': 'public, max-age=3600' });
        }
    } catch (e) {}
    
    try {
        const frontendUrl = new URL(c.req.url).origin;
        const feed = await generateFeed(env, db, frontendUrl, c);
        let content: string;
        if (fileName.endsWith('.json')) content = feed.json1();
        else if (fileName === 'atom.xml') content = feed.atom1();
        else content = feed.rss2();
        
        return c.text(content, 200, { 'Content-Type': contentTypeMap[fileName] || 'application/xml', 'Cache-Control': 'public, max-age=300' });
    } catch (e: any) {
        return c.text(`Generation failed: ${e.message}`, 500);
    }
}

async function generateFeed(env: Env, db: DB, frontendUrl: string, c?: AppContext) {
    c ? await profileAsync(c, 'rss_init_modules', () => initRSSModules()) : await initRSSModules();
    const faviconKey = getFaviconKey(env);
    const feedConfig: any = {
        title: env.RSS_TITLE || "Rin Feed",
        description: env.RSS_DESCRIPTION || "Feed from Rin",
        id: frontendUrl,
        link: frontendUrl,
        copyright: "All rights reserved 2026",
        updated: new Date(),
        generator: "Feed from Rin",
        feedLinks: { rss: `${frontendUrl}/rss.xml`, json: `${frontendUrl}/rss.json`, atom: `${frontendUrl}/atom.xml` },
    };

    const queryConfig = {
        where: and(eq(feeds.draft, 0), eq(feeds.listed, 1)),
        orderBy: [desc(feeds.createdAt), desc(feeds.updatedAt)],
        limit: 20,
        columns: { id: true, alias: true, title: true, summary: true, content: true, createdAt: true, updatedAt: true },
        with: { user: { columns: { id: true, username: true, avatar: true } } },
    };

    const feed_list = (await db.query.feeds.findMany(queryConfig as any)) as any[];

    const feed = new Feed(feedConfig);
    for (const f of feed_list) {
        let contentHtml = '';
        if (f.content) {
            try {
                const file = await unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify).process(f.content);
                contentHtml = file.toString();
            } catch (e) { contentHtml = f.content; }
        }

        feed.addItem({
            title: f.title || "No title",
            id: f.id?.toString() || "0",
            // 核心逻辑：确保使用别名
            link: f.alias ? `${frontendUrl}/${f.alias}` : `${frontendUrl}/feed/${f.id}`,
            date: f.createdAt,
            description: f.summary || f.content?.slice(0, 100) || "",
            content: contentHtml,
            author: f.user ? [{ name: f.user.username }] : undefined,
            image: extractImage(f.content),
        });
    }
    return feed;
}

export async function rssCrontab(env: Env, db: DB) {
    const feed = await generateFeed(env, db, '');
    const folder = env.S3_CACHE_FOLDER || "cache/";
    const save = async (name: string, data: string) => {
        try {
            await putStorageObjectAtKey(env, path_join(folder, name), data, name.endsWith('.json') ? 'application/json' : 'application/xml');
        } catch (e) {}
    };
    await Promise.all([save("rss.xml", feed.rss2()), save("atom.xml", feed.atom1()), save("rss.json", feed.json1())]);
}
