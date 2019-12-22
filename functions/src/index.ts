import * as functions from 'firebase-functions'
import * as getUrls from 'get-urls'
import fetch, { Headers } from 'node-fetch'
import * as cors from 'cors'
import * as urlParser from 'url'
import * as robotsParser from 'robots-parser'
import * as admin from 'firebase-admin'
import * as ogs from 'open-graph-scraper'

admin.initializeApp()

const storage = admin.storage()
const corsHandler = cors({ origin: true })
const userAgent = 'KarazannBot-Links/1.0 (+https://www.karazann.com/bot)'
const headers = new Headers({
    'User-Agent': userAgent
})

const downloadUrl = async (url: string, followRedirect: boolean = false) => {
    const defaultOptions = {
        method: 'GET',
        headers,
        encoding: null,
        followRedirect,
        gzip: true
    }

    const res = await fetch(url, defaultOptions)
    return await res.text()
}

const getRobotsUrl = (url: string) => {
    const parsedUrl = urlParser.parse(url)

    // There's a robots for every (host, protocol, port) combination
    const robotsUrl = urlParser.format({
        host: parsedUrl.host,
        protocol: parsedUrl.protocol,
        port: parsedUrl.port || undefined,
        pathname: '/robots.txt'
    })

    return robotsUrl
}

// TIP: Replace with redis maybe
const saveCache = async (
    cacheName: string,
    objectKey: string,
    objectValue: string
) => {
    await storage
        .bucket(cacheName)
        .file(objectKey)
        .save(objectValue)
    // console.log('saved cache')
}

// TIP: Replace with redis maybe
const getCache = async (cacheName: string, objectKey: string) => {
    try {
        const [cacheFile] = await storage
            .bucket(cacheName)
            .file(objectKey)
            .download()

        // console.log('from cache')
        if (cacheFile) return cacheFile.toString()
        else return undefined
    } catch (e) {
        // console.error('cache not found')
        return undefined
    }
}

const getRobotsTXT = async (url: string) => {
    // Check if this robots.txt file already exists in the cache.
    const parsedUrl = urlParser.parse(url)

    let robotsTXT

    robotsTXT = await getCache('karazann-robots', parsedUrl.host!)
    if (robotsTXT) return robotsTXT

    const robotsUrl = getRobotsUrl(url)
    robotsTXT = await downloadUrl(robotsUrl)

    await saveCache('karazann-robots', parsedUrl.host!, robotsTXT)
    return robotsTXT
}

const extractMetadata = async (url: string): Promise<any> => {
    const html = await downloadUrl(url)

    return new Promise((res, rej) => {
        ogs({ html }, (error: any, results: any) => {
            if (error) rej(error)
            res(results)
        })
    })
}

const scrapeMetatags = (text: string) => {
    const urls = Array.from(getUrls(text))

    const requests = urls.map(async url => {
        const robotsTxt = await getRobotsTXT(url)

        const robots = robotsParser(getRobotsUrl(url), robotsTxt)
        const isAllowed = robots.isAllowed(url, userAgent)

        if (isAllowed) {
            const cacheKey = url.replace(/\//g, '_')

            const linkPreviewString = await getCache(
                'karazann-link-preview',
                cacheKey
            )
            // If we can get from the cache get from there
            if (linkPreviewString) return JSON.parse(linkPreviewString)

            try {
                const meta = await extractMetadata(url)

                const image = meta.data.twitterImage || meta.data.ogImage
                let images = []
                
                if (Array.isArray(image)) {
                    images = [...image]
                } else {
                    images = [image]
                }

                const relative = new RegExp('^(?:[a-z]+:)?//', 'i')
                images.forEach((i: any) => {
                    const parsedUrl = urlParser.parse(url)
                    const imageUrl = i.url

                    delete i.height
                    delete i.width
                    delete i.alt

                    if (!relative.test(imageUrl)) {
                        const newUrl = urlParser.format({
                            host: parsedUrl.host,
                            protocol: parsedUrl.protocol,
                            port: parsedUrl.port || undefined,
                            pathname: imageUrl
                        })

                        i.url = newUrl
                    }
                })

                const linkPreview = {
                    success: true,
                    url,
                    title:
                        meta.data.twitterTitle ||
                        meta.data.ogTitle ||
                        meta.data.ogSiteName,
                    images
                }

                await saveCache(
                    'karazann-link-preview',
                    cacheKey,
                    JSON.stringify(linkPreview)
                )

                return linkPreview
            } catch (e) {
                return {
                    success: false,
                    status: 'failed'
                }
            }
        } else {
            return {
                success: false,
                status: 'not allowed',
                url
            }
        }
    })

    return Promise.all(requests)
}

export const scraper = functions.https.onRequest(async (req, res) => {
    corsHandler(req, res, async () => {
        if (req.query.text) {
            // console.log(req.query.text)
            const body = req.query
            const data = await scrapeMetatags(body.text)
            res.send(data)
        } else {
            res.status(422).send({
                success: false
            })
        }
    })
})
