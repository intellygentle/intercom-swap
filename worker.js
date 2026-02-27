async function researchWikipedia(topic) {
  const encodedTopic = encodeURIComponent(topic);
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=true&explaintext=true&titles=${encodedTopic}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'IntercomResearchAgent/1.0 (https://github.com/intercom-swap; research-bot@example.com)'
      }
    });
    
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const pages = data.query.pages;
    const pageId = Object.keys(pages)[0];
    
    if (pageId === "-1") return 'No Wikipedia article found.';

    const extract = pages[pageId].extract;
    
    if (extract) {
      return extract.substring(0, 500) + '...';
    } else {
      return 'No Wikipedia article found for this topic.';
    }
  } catch (error) {
    return `Error fetching Wikipedia: ${error.message}`;
  }
}

// Only run test if this file is executed directly
const isMainModule = process.argv[1] && process.argv[1].includes('worker.js');
if (isMainModule) {
  (async () => {
    const topic = process.argv[2] || 'Artificial Intelligence';
    console.log(`\n🔍 Worker Agent researching: "${topic}"\n`);
    const result = await researchWikipedia(topic);
    console.log('📄 Result:\n');
    console.log(result);
    console.log('\n✅ Research complete!\n');
  })();
}

export default researchWikipedia;
