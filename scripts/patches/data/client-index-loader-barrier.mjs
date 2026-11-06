export const CLIENT_INDEX_LOADER_BARRIER_MARKER = 'dsh-mobile client index Loader barrier (G2)'

export function planClientIndexLoaderBarrier(source) {
	if (source.includes(CLIENT_INDEX_LOADER_BARRIER_MARKER)) return source
	const bodyBefore = 'body = renderIndex(await readFile(distIndex, "utf8"));'
	if (source.split(bodyBefore).length !== 2) throw new Error('client-index Loader barrier anchor mismatch: index renderer await')
	source = source.replace(bodyBefore, 'body = await renderIndex(await readFile(distIndex, "utf8"));')
	const renderBefore = '(html) => ctx.webServer.renderIndex(html, peer ?? ctx.connection.browserPeer).replace(/<head(?:\\s[^>]*)?>/i, (open) => `${open}<base href="./">`)'
	const renderAfter = [
		'async (html) => {',
			`/* ${CLIENT_INDEX_LOADER_BARRIER_MARKER}: wait for clientModules' startup flush before rendering the graph. */`,
			'await ctx.get("loader").await();',
			'return ctx.webServer.renderIndex(html, peer ?? ctx.connection.browserPeer).replace(/<head(?:\\s[^>]*)?>/i, (open) => `${open}<base href="./">`);',
		'}',
	].map((line, index) => index === 0 || index === 4 ? line : `\t\t\t${line}`).join('\n')
	if (source.split(renderBefore).length !== 2) throw new Error('client-index Loader barrier anchor mismatch: peer renderer')
	return source.replace(renderBefore, renderAfter)
}
