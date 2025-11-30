# Xing Jobs Scraper

Extract comprehensive job listings from Xing.com, one of Europe's leading professional networking platforms. This scraper efficiently collects job postings with detailed information including titles, companies, locations, salaries, employment types, and full job descriptions.

## What can this scraper do?

Xing Jobs Scraper enables you to:

- **Search by keyword** - Find jobs matching specific titles or skills
- **Filter by location** - Target opportunities in specific cities or regions across Europe
- **Filter by discipline** - Focus on particular industries or professional fields
- **Extract detailed job data** - Get complete information including salary ranges and employment types
- **Handle pagination** - Automatically navigate through multiple pages of search results
- **Export structured data** - Receive results in clean, consistent JSON format ready for analysis

Perfect for recruitment agencies, job market analysts, career platforms, and businesses conducting competitive intelligence.

## Input configuration

The scraper accepts the following input parameters:

| Field | Type | Description | Required |
|-------|------|-------------|----------|
| `keyword` | String | Job title or search term (e.g., "Remote", "Software Developer", "Project Manager") | No |
| `location` | String | City or region to filter results (e.g., "Berlin", "Munich", "Hamburg") | No |
| `discipline` | String | Professional field or industry (e.g., "Technology", "Marketing", "Finance") | No |
| `startUrl` | String | Direct Xing jobs search URL to start scraping from | No |
| `collectDetails` | Boolean | Visit individual job pages for complete descriptions (default: `true`) | No |
| `results_wanted` | Integer | Maximum number of jobs to collect (default: `100`) | No |
| `max_pages` | Integer | Maximum number of search result pages to visit (default: `20`) | No |
| `proxyConfiguration` | Object | Proxy settings for reliable scraping (residential proxies recommended) | No |

### Input example

```json
{
  "keyword": "Remote",
  "location": "Berlin",
  "discipline": "Technology",
  "results_wanted": 50,
  "max_pages": 5,
  "collectDetails": true,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

You can also provide a direct Xing search URL:

```json
{
  "startUrl": "https://www.xing.com/jobs/t-remote?keywords=Remote",
  "results_wanted": 100,
  "collectDetails": true
}
```

## Output format

Each job listing in the dataset contains:

```json
{
  "title": "Senior Software Developer",
  "company": "Tech Company GmbH",
  "location": "Berlin",
  "salary": "€60,000 – €80,000",
  "job_type": "Full-time",
  "discipline": "Technology",
  "date_posted": "2025-11-28",
  "description_html": "<p>We are looking for...</p>",
  "description_text": "We are looking for...",
  "url": "https://www.xing.com/jobs/berlin-senior-software-developer-12345678"
}
```

### Output fields explained

- **title** - Job title or position name
- **company** - Company or organization name
- **location** - Geographic location of the job
- **salary** - Salary range or compensation information
- **job_type** - Employment type (Full-time, Part-time, Contract, etc.)
- **discipline** - Professional field or industry category
- **date_posted** - When the job was posted
- **description_html** - Full job description in HTML format
- **description_text** - Plain text version of the job description
- **url** - Direct link to the job posting on Xing

## Usage examples

### Example 1: Search for remote technology jobs

Search for remote positions in the technology sector across Germany:

```json
{
  "keyword": "Remote",
  "discipline": "Technology",
  "results_wanted": 100
}
```

### Example 2: Location-specific search

Find marketing jobs in Munich:

```json
{
  "keyword": "Marketing Manager",
  "location": "Munich",
  "discipline": "Marketing",
  "results_wanted": 50,
  "collectDetails": true
}
```

### Example 3: Quick URL-based scrape

Scrape jobs from a specific Xing search URL without detailed pages:

```json
{
  "startUrl": "https://www.xing.com/jobs/berlin-jobs",
  "collectDetails": false,
  "results_wanted": 200
}
```

## Best practices

### Proxy configuration

For reliable scraping, use residential proxies:

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Rate limiting

- Start with smaller `results_wanted` values (50-100) for testing
- Use `max_pages` to prevent excessive scraping
- Enable `collectDetails` only when full job descriptions are needed

### Optimal performance

- Be specific with keywords to get more relevant results
- Combine keyword, location, and discipline filters for targeted searches
- Use direct URLs (`startUrl`) when you have a specific search criteria

## Data export

Export your scraped data in multiple formats:

- **JSON** - For programmatic processing and integrations
- **CSV** - For spreadsheet analysis and data science workflows
- **Excel** - For business reporting and sharing
- **HTML** - For human-readable reports

Access your data via:
- Apify API for automated workflows
- Direct dataset download from the platform
- Webhook notifications when scraping completes

## Use cases

### Recruitment and talent acquisition
Track job openings across multiple companies and industries to identify hiring trends and candidate opportunities.

### Market research
Analyze salary ranges, job requirements, and employment trends in specific regions or industries.

### Competitive intelligence
Monitor competitors' hiring patterns and team expansion to gain business insights.

### Job aggregation platforms
Feed fresh job listings into your job board or career portal automatically.

### Career planning
Research available positions, required skills, and compensation ranges in your field.

## Limitations

- Scraping speed depends on the number of results and whether detailed pages are visited
- Some job listings may require authentication or have access restrictions
- Salary information may not be available for all positions
- The scraper respects website structure; layout changes may require updates

## Support

Need help or have questions?

- Check the [Apify documentation](https://docs.apify.com)
- Review input examples above
- Contact support through the Apify platform

## Legal and ethical considerations

This scraper is designed to collect publicly available job listing data. Users are responsible for:

- Complying with Xing's Terms of Service
- Respecting website usage policies
- Following data protection regulations (GDPR, etc.)
- Using scraped data ethically and legally

Always ensure your use case complies with applicable laws and platform terms.

---

**Ready to start scraping Xing jobs?** Configure your input parameters and run the scraper to collect valuable job market data in minutes.
